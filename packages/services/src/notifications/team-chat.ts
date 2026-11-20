/**
 * Messagerie d'équipe : un canal Slack ou Microsoft Teams relié à l'espace par un webhook
 * entrant. Y sont annoncés les posts à valider, les échecs de publication et les posts
 * publiés, pour que l'équipe les relaie (réactions, commentaires, partages).
 *
 * L'adresse du webhook vaut un mot de passe : chiffrée, jamais réaffichée. Seules les
 * adresses des services officiels sont admises (pas de requête vers une autre machine).
 */
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import type { TokenEncryptor } from '../accounts/accounts.ts';
import { workspaceRole } from '../access.ts';
import { audit } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { checkPublicUrl } from '../net/safe-fetch.ts';

export const CHAT_PROVIDERS = { slack: 'Slack', teams: 'Microsoft Teams' } as const;
export type ChatProvider = keyof typeof CHAT_PROVIDERS;

export const CHAT_EVENTS = {
  a_valider: 'Posts prêts à valider',
  erreurs: 'Échecs de publication',
  publies: 'Posts publiés, à relayer par l’équipe',
} as const;
export type ChatEvent = keyof typeof CHAT_EVENTS;

/** Hôtes des webhooks entrants : Slack, et Teams (Workflows / Power Automate, anciens connecteurs). */
const HOSTS: Record<ChatProvider, readonly RegExp[]> = {
  slack: [/^hooks\.slack\.com$/],
  teams: [/\.logic\.azure\.com$/, /\.powerplatform\.com$/, /\.powerautomate\.com$/, /\.webhook\.office\.com$/],
};

export function checkChatWebhook(provider: ChatProvider, raw: string): URL {
  let url: URL;
  try {
    url = checkPublicUrl(raw.trim());
  } catch {
    throw new RefusedError('messagerie_adresse', 'Adresse de webhook invalide.');
  }
  if (url.protocol !== 'https:' || url.toString().length > 1000 || url.username !== '' || url.password !== '' || !HOSTS[provider].some((h) => h.test(url.hostname))) {
    throw new RefusedError('messagerie_adresse', `Ce n’est pas une adresse de webhook ${CHAT_PROVIDERS[provider]}.`);
  }
  return url;
}

export interface TeamChat {
  readonly provider: ChatProvider;
  /** Début de l'adresse, pour la reconnaître (jamais l'adresse entière). */
  readonly urlHint: string;
  readonly events: readonly ChatEvent[];
  readonly lastSentAt: Date | null;
  readonly lastError: string | null;
}

async function requireAdmin(trx: Tx, userId: string, workspaceId: string): Promise<void> {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  if (role !== 'owner' && role !== 'admin') throw new ForbiddenError('teamChat');
}

export async function getTeamChat(db: Database, userId: string, workspaceId: string): Promise<TeamChat | null> {
  await asUser(db, userId, (trx) => requireAdmin(trx, userId, workspaceId));
  const row = await asSystem(db, (trx) =>
    trx.selectFrom('workspace_chat_hooks').select(['provider', 'url_hint', 'events', 'last_sent_at', 'last_error']).where('workspace_id', '=', workspaceId).executeTakeFirst(),
  );
  if (row === undefined) return null;
  return { provider: row.provider as ChatProvider, urlHint: row.url_hint, events: row.events.filter((e): e is ChatEvent => e in CHAT_EVENTS), lastSentAt: row.last_sent_at, lastError: row.last_error };
}

export async function setTeamChat(
  db: Database,
  cipher: TokenEncryptor,
  userId: string,
  workspaceId: string,
  input: { readonly provider: string; readonly url: string; readonly events: readonly string[] },
  now: Date,
): Promise<void> {
  if (!(input.provider in CHAT_PROVIDERS)) throw new RefusedError('choix_inconnu', 'Messagerie inconnue.');
  const provider = input.provider as ChatProvider;
  const events = [...new Set(input.events)].filter((e): e is ChatEvent => e in CHAT_EVENTS);
  await asUser(db, userId, (trx) => requireAdmin(trx, userId, workspaceId));
  await asSystem(db, async (trx) => {
    const existing = await trx.selectFrom('workspace_chat_hooks').select('provider').where('workspace_id', '=', workspaceId).executeTakeFirst();
    // Adresse vide : on garde celle enregistrée (seuls les événements changent).
    if (input.url.trim() === '') {
      if (existing === undefined || existing.provider !== provider) throw new RefusedError('messagerie_adresse', 'Collez l’adresse du webhook.');
      await trx.updateTable('workspace_chat_hooks').set({ events }).where('workspace_id', '=', workspaceId).execute();
    } else {
      const url = checkChatWebhook(provider, input.url);
      const values = {
        provider,
        url_enc: Buffer.from(cipher.encrypt(url.toString(), `chat:${workspaceId}`)),
        url_hint: `${url.host}${url.pathname.slice(0, 12)}…`,
        events,
        created_by: userId,
        created_at: now,
        last_error: null,
      };
      await trx.insertInto('workspace_chat_hooks').values({ workspace_id: workspaceId, ...values }).onConflict((oc) => oc.column('workspace_id').doUpdateSet(values)).execute();
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: 'messagerie.reliee', entity: 'workspace', entityId: workspaceId, details: { provider, events }, at: now });
  });
}

export async function removeTeamChat(db: Database, userId: string, workspaceId: string, now: Date): Promise<void> {
  await asUser(db, userId, (trx) => requireAdmin(trx, userId, workspaceId));
  await asSystem(db, async (trx) => {
    await trx.deleteFrom('workspace_chat_hooks').where('workspace_id', '=', workspaceId).execute();
    await trx.deleteFrom('chat_messages').where('workspace_id', '=', workspaceId).where('status', 'is', null).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'messagerie.retiree', entity: 'workspace', entityId: workspaceId, details: {}, at: now });
  });
}

/** Message d'essai, envoyé par le worker dans la minute. */
export async function testTeamChat(db: Database, userId: string, workspaceId: string, now: Date): Promise<void> {
  await asUser(db, userId, (trx) => requireAdmin(trx, userId, workspaceId));
  await asSystem(db, async (trx) => {
    const hook = await trx.selectFrom('workspace_chat_hooks').select('workspace_id').where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (hook === undefined) throw new RefusedError('messagerie_absente', 'Aucune messagerie reliée.');
    await trx.insertInto('chat_messages').values({ workspace_id: workspaceId, event: 'essai', payload: JSON.stringify({}), created_at: now }).execute();
  });
}

/**
 * Met un message en file si l'espace a relié une messagerie et choisi cet événement
 * (appelé par le code système, dans la transaction qui produit l'événement).
 */
export async function enqueueTeamChat(trx: Tx, workspaceId: string, event: ChatEvent, payload: Record<string, unknown>): Promise<boolean> {
  const hook = await trx.selectFrom('workspace_chat_hooks').select('events').where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (hook === undefined || !hook.events.includes(event)) return false;
  await trx.insertInto('chat_messages').values({ workspace_id: workspaceId, event, payload: JSON.stringify(payload) }).execute();
  return true;
}

// --- Textes ---------------------------------------------------------------------------

export interface ChatText {
  readonly text: string;
  readonly link: { readonly label: string; readonly url: string } | null;
}

export interface ChatContext {
  readonly appUrl: string;
  readonly workspaceName: string;
  /** Post concerné, lu par le worker au moment de l'envoi. */
  readonly post?: { readonly accountName: string; readonly excerpt: string } | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

export function teamChatText(event: string, payload: Record<string, unknown>, ctx: ChatContext): ChatText | null {
  const postId = typeof payload['postId'] === 'string' ? payload['postId'] : null;
  const excerpt = ctx.post?.excerpt ? ` « ${ctx.post.excerpt} »` : '';
  switch (event) {
    case 'a_valider': {
      const count = Math.max(1, Number(payload['count']) || 1);
      return {
        text: `${ctx.workspaceName} : ${plural(count, 'post')} prêt${count > 1 ? 's' : ''} à valider. Chacun valide les siens depuis « Mes posts », en quelques secondes.`,
        link: { label: 'Voir mes posts', url: `${ctx.appUrl}/` },
      };
    }
    case 'erreurs': {
      const message = typeof payload['message'] === 'string' ? payload['message'] : 'erreur inconnue';
      return {
        text: `${ctx.workspaceName} : un post de ${ctx.post?.accountName ?? 'l’espace'} n’a pas pu être publié (${message}).`,
        link: postId === null ? null : { label: 'Voir le post', url: `${ctx.appUrl}/posts/${encodeURIComponent(postId)}` },
      };
    }
    case 'publies': {
      const url = typeof payload['url'] === 'string' && /^https:\/\//.test(payload['url']) ? payload['url'] : null;
      return {
        text: `Nouveau post publié par ${ctx.post?.accountName ?? ctx.workspaceName}${excerpt}. Une réaction ou un commentaire de l’équipe dans la première heure l’aide à être vu.`,
        link: url === null ? null : { label: 'Ouvrir sur LinkedIn', url },
      };
    }
    case 'essai':
      return { text: `Message d’essai : la messagerie de l’équipe ${ctx.workspaceName} est bien reliée à Rostra.`, link: null };
    default:
      return null;
  }
}

/** Corps JSON du webhook : texte Slack (liens au format Slack) ou carte adaptative Teams. */
export function teamChatPayload(provider: ChatProvider, message: ChatText): Record<string, unknown> {
  if (provider === 'slack') {
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { text: `${escape(message.text)}${message.link ? `\n<${message.link.url}|${escape(message.link.label)}>` : ''}` };
  }
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [{ type: 'TextBlock', text: message.text, wrap: true }],
          ...(message.link && { actions: [{ type: 'Action.OpenUrl', title: message.link.label, url: message.link.url }] }),
        },
      },
    ],
  };
}

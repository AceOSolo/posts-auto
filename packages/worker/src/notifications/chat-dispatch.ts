/**
 * Envoi des messages de la messagerie d'équipe (Slack, Teams), toutes les minutes.
 *
 * - Erreur passagère (réseau, 429, 5xx) : nouvel essai au passage suivant, 5 essais au plus.
 * - Refus définitif (4xx : webhook supprimé ou révoqué) : en échec, et l'erreur est montrée
 *   dans les réglages de l'espace.
 * - Un message de plus d'un jour n'est plus envoyé (« à valider » serait trompeur).
 */
import { type Database, asSystem } from '@posts-auto/db';
import { type ChatProvider, teamChatPayload, teamChatText } from '@posts-auto/services';
import type { TokenCipher } from '../secrets/token-cipher.ts';

export const MAX_CHAT_ATTEMPTS = 5;
const STALE_AFTER_MS = 86_400_000;
const BATCH = 50;
const TIMEOUT_MS = 10_000;

export interface ChatDispatchDeps {
  readonly db: Database;
  readonly cipher: Pick<TokenCipher, 'decrypt'>;
  readonly appUrl: string;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
}

export interface ChatDispatchReport {
  readonly sent: string[];
  readonly retrying: string[];
  readonly failed: string[];
  readonly stale: number;
}

class ChatSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function post(fetcher: typeof fetch, url: string, body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ChatSendError(`Messagerie injoignable : ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (response.ok) return;
  const retryable = response.status === 429 || response.status >= 500;
  throw new ChatSendError(
    response.status === 404 || response.status === 410 || response.status === 403
      ? `Le webhook a été supprimé ou révoqué (HTTP ${response.status}) : reliez de nouveau la messagerie.`
      : `La messagerie a refusé le message (HTTP ${response.status}).`,
    retryable,
  );
}

export async function runChatDispatch(deps: ChatDispatchDeps): Promise<ChatDispatchReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const fetcher = deps.fetch ?? fetch;
  const stale = await asSystem(deps.db, (trx) =>
    trx
      .updateTable('chat_messages')
      .set({ status: 'skipped', last_error: 'Périmé : non envoyé' })
      .where('status', 'is', null)
      .where('created_at', '<', new Date(now.getTime() - STALE_AFTER_MS))
      .executeTakeFirst(),
  );
  const report: ChatDispatchReport = { sent: [], retrying: [], failed: [], stale: Number(stale.numUpdatedRows) };

  const done: string[] = [];
  for (let i = 0; i < BATCH; i += 1) {
    const processed = await asSystem(deps.db, async (trx) => {
      let query = trx
        .selectFrom('chat_messages as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .leftJoin('workspace_chat_hooks as h', 'h.workspace_id', 'm.workspace_id')
        .select(['m.id', 'm.workspace_id', 'm.event', 'm.payload', 'm.attempts', 'w.name as workspace_name', 'h.provider', 'h.url_enc'])
        .where('m.status', 'is', null)
        .orderBy('m.created_at')
        .limit(1)
        .forUpdate('m')
        .skipLocked();
      if (done.length > 0) query = query.where('m.id', 'not in', done);
      const row = await query.executeTakeFirst();
      if (row === undefined) return false;
      const id = String(row.id);
      done.push(id);
      const payload = (row.payload ?? {}) as Record<string, unknown>;

      let postInfo: { accountName: string; excerpt: string } | null = null;
      if (typeof payload['postId'] === 'string' && /^[0-9a-f-]{36}$/i.test(payload['postId'])) {
        const p = await trx
          .selectFrom('posts as p')
          .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
          .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
          .select(['a.display_name', 'v.body'])
          .where('p.id', '=', payload['postId'])
          .where('p.workspace_id', '=', row.workspace_id)
          .executeTakeFirst();
        if (p !== undefined) {
          const firstLine = (p.body ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
          postInfo = { accountName: p.display_name ?? 'Compte', excerpt: firstLine.length > 120 ? `${firstLine.slice(0, 117).trimEnd()}…` : firstLine.trim() };
        }
      }
      const text = teamChatText(row.event, payload, { appUrl: deps.appUrl, workspaceName: row.workspace_name, post: postInfo });
      if (row.provider === null || row.url_enc === null || text === null) {
        await trx.updateTable('chat_messages').set({ status: 'skipped', last_error: row.provider === null ? 'Messagerie retirée' : 'Message inconnu' }).where('id', '=', row.id).execute();
        return true;
      }

      try {
        const url = deps.cipher.decrypt(row.url_enc, `chat:${row.workspace_id}`);
        await post(fetcher, url, teamChatPayload(row.provider as ChatProvider, text));
        await trx.updateTable('chat_messages').set({ status: 'sent', sent_at: now, attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
        await trx.updateTable('workspace_chat_hooks').set({ last_sent_at: now, last_error: null }).where('workspace_id', '=', row.workspace_id).execute();
        report.sent.push(id);
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        const retry = error instanceof ChatSendError && error.retryable && attempts < MAX_CHAT_ATTEMPTS;
        await trx
          .updateTable('chat_messages')
          .set({ attempts, last_error: message, status: retry ? null : 'failed' })
          .where('id', '=', row.id)
          .execute();
        if (!retry) await trx.updateTable('workspace_chat_hooks').set({ last_error: message }).where('workspace_id', '=', row.workspace_id).execute();
        (retry ? report.retrying : report.failed).push(id);
      }
      return true;
    });
    if (!processed) break;
  }
  return report;
}

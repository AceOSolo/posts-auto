/**
 * IDE-07 : création d'idée ou de demande par e-mail (Brevo, « Inbound Parsing »).
 *
 * Brevo ne signe pas ces webhooks et l'expéditeur d'un e-mail peut être usurpé. Protections :
 * - webhook à adresse secrète ;
 * - adresse d'e-mail secrète par espace, renouvelable ;
 * - l'expéditeur doit être un membre autorisé à proposer ;
 * - e-mails indésirables et échecs SPF écartés, 30 entrées au plus par jour et par espace.
 *
 * Un e-mail ne publie jamais rien : il crée une idée ou une demande, et tout post qui en sort
 * passe par la validation de son titulaire. Aucune réponse n'est envoyée à l'expéditeur, pour
 * ne pas confirmer une adresse ni renvoyer de courrier vers une adresse usurpée.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { canManageContent, canPropose, workspaceRole } from '../access.ts';
import { audit } from '../audit.ts';
import { hashToken, normalizeEmail } from '../auth/auth.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { lockReference } from '../exchange/api-keys.ts';
import { createPostRequest, saveIdea } from './ideas-requests.ts';

export interface InboundEmailConfig {
  /** Sous-domaine de réception, distinct du domaine d'envoi. */
  readonly domain: string;
  /** Secret dont sont dérivées les adresses des espaces. */
  readonly secret: string;
  /** Secret présent dans l'adresse du webhook déclarée chez Brevo. */
  readonly webhookSecret: string;
}

export function inboundConfigFromEnv(env: Record<string, string | undefined>): InboundEmailConfig | null {
  const domain = env['INBOUND_EMAIL_DOMAIN']?.trim().toLowerCase();
  const secret = env['INBOUND_EMAIL_SECRET']?.trim();
  const webhookSecret = env['INBOUND_EMAIL_WEBHOOK_SECRET']?.trim();
  return domain && secret && webhookSecret ? { domain, secret, webhookSecret } : null;
}

export const INBOUND_DAILY_LIMIT = 30;
/** Score rspamd à partir duquel un e-mail est traité comme indésirable. */
export const INBOUND_SPAM_THRESHOLD = 5;
const INBOUND_RETENTION_DAYS = 30;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 20;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/** En minuscules et sans signe particulier : une partie locale d'adresse n'est pas sensible à la casse. */
export function inboundToken(secret: string, workspaceId: string, rotation: number): string {
  return base32(createHmac('sha256', secret).update(`${workspaceId}:${rotation}`).digest().subarray(0, 16));
}

const addressOf = (config: InboundEmailConfig, workspaceId: string, rotation: number) => `idees-${inboundToken(config.secret, workspaceId, rotation)}@${config.domain}`;

// --- Réglages de l'espace ---

export interface InboundEmailSettings {
  /** Le service est configuré par l'éditeur. */
  readonly available: boolean;
  readonly address: string | null;
  readonly canManage: boolean;
}

export async function inboundEmailSettings(db: Database, userId: string, workspaceId: string, config: InboundEmailConfig | null): Promise<InboundEmailSettings> {
  const role = await asUser(db, userId, (trx) => workspaceRole(trx, userId, workspaceId));
  if (role === null) throw new NotFoundError('Espace');
  const canManage = canManageContent(role);
  if (config === null || !canPropose(role)) return { available: config !== null && canPropose(role), address: null, canManage };
  const row = await asSystem(db, (trx) => trx.selectFrom('workspace_inbound_email').select('rotation').where('workspace_id', '=', workspaceId).executeTakeFirst());
  return { available: true, address: row === undefined ? null : addressOf(config, workspaceId, row.rotation), canManage };
}

async function requireManager(db: Database, userId: string, workspaceId: string): Promise<void> {
  const role = await asUser(db, userId, (trx) => workspaceRole(trx, userId, workspaceId));
  if (role === null) throw new NotFoundError('Espace');
  if (!canManageContent(role)) throw new ForbiddenError('manageInboundEmail');
}

/** Crée l'adresse de l'espace, ou la remplace : l'ancienne cesse aussitôt de fonctionner. */
export async function renewInboundAddress(db: Database, userId: string, workspaceId: string, config: InboundEmailConfig | null, now: Date): Promise<string> {
  if (config === null) throw new RefusedError('email_non_configure', 'La réception d’e-mails n’est pas configurée.');
  await requireManager(db, userId, workspaceId);
  return asSystem(db, async (trx) => {
    await lockReference(trx, workspaceId, 'email', 'adresse');
    const existing = await trx.selectFrom('workspace_inbound_email').select('rotation').where('workspace_id', '=', workspaceId).executeTakeFirst();
    const rotation = (existing?.rotation ?? 0) + 1;
    const token_hash = hashToken(inboundToken(config.secret, workspaceId, rotation));
    await trx
      .insertInto('workspace_inbound_email')
      .values({ workspace_id: workspaceId, rotation, token_hash, created_by: userId })
      .onConflict((oc) => oc.column('workspace_id').doUpdateSet({ rotation, token_hash }))
      .execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: existing === undefined ? 'email_entrant.active' : 'email_entrant.renouvele', entity: 'workspace', entityId: workspaceId, details: {}, at: now });
    return addressOf(config, workspaceId, rotation);
  });
}

export async function disableInboundAddress(db: Database, userId: string, workspaceId: string, now: Date): Promise<void> {
  await requireManager(db, userId, workspaceId);
  await asSystem(db, async (trx) => {
    await trx.deleteFrom('workspace_inbound_email').where('workspace_id', '=', workspaceId).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'email_entrant.desactive', entity: 'workspace', entityId: workspaceId, details: {}, at: now });
  });
}

// --- Lecture du webhook Brevo ---

export interface InboundEmail {
  readonly messageId: string;
  readonly from: string | null;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly spamScore: number | null;
  readonly spfFailed: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// PostgreSQL refuse le caractère nul, qu'un e-mail peut contenir.
const withoutNul = (value: string) => value.replaceAll('\u0000', '');
const asString = (value: unknown) => (typeof value === 'string' ? withoutNul(value) : '');
const mailbox = (value: unknown): string | null => {
  if (typeof value === 'string') return withoutNul(value);
  return isRecord(value) && typeof value['Address'] === 'string' ? withoutNul(value['Address']) : null;
};
const mailboxes = (value: unknown): string[] => (Array.isArray(value) ? value.map(mailbox).filter((a): a is string => a !== null) : []);

function spamScoreOf(item: Record<string, unknown>): number | null {
  // La documentation décrit « Spam.Score », son exemple montre « SpamScore ».
  const spam = item['Spam'];
  const score = isRecord(spam) ? spam['Score'] : item['SpamScore'];
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
}

function spfFailedIn(headers: unknown): boolean {
  if (!isRecord(headers)) return false;
  const value = headers['Received-SPF'];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && /^\s*fail\b/i.test(first);
}

export function parseBrevoInbound(payload: unknown): InboundEmail[] {
  if (!isRecord(payload) || !Array.isArray(payload['items'])) return [];
  return payload['items'].filter(isRecord).slice(0, MAX_ITEMS).map((item) => ({
    messageId: asString(item['MessageId']).trim(),
    from: mailbox(item['From']),
    recipients: [...new Set([...mailboxes(item['Recipients']), ...mailboxes(item['To']), ...mailboxes(item['Cc'])])],
    subject: asString(item['Subject']).trim(),
    text: (asString(item['ExtractedMarkdownMessage']) || asString(item['RawTextBody'])).trim(),
    spamScore: spamScoreOf(item),
    spfFailed: spfFailedIn(item['Headers']),
  }));
}

/** Objet de l'e-mail : « Demande : … » crée une demande, sinon une idée. Les « Re : » et « Fwd : » sont retirés. */
export function parseInboundSubject(subject: string): { kind: 'idea' | 'request'; title: string } {
  const clean = subject.replace(/^(\s*(re|fw|fwd|tr)\s*:\s*)+/i, '').trim();
  const prefix = /^(demande|id[ée]e)\s*:\s*/i.exec(clean);
  if (prefix === null) return { kind: 'idea', title: clean };
  return { kind: (prefix[1] as string).toLowerCase() === 'demande' ? 'request' : 'idea', title: clean.slice(prefix[0].length).trim() };
}

const firstLink = (text: string) => {
  const url = /https?:\/\/[^\s<>()[\]"']+/i.exec(text)?.[0]?.replace(/[.,;:!?]+$/, '');
  return url !== undefined && url.length <= 1000 ? url : null;
};

// --- Traitement ---

export type InboundOutcome = { readonly kind: 'idea' | 'request'; readonly id: string } | { readonly kind: 'ignored'; readonly reason: string };

function targetToken(email: InboundEmail, domain: string): string | null {
  for (const recipient of email.recipients) {
    const match = /^idees-([a-z2-7]{26})@(.+)$/.exec(recipient.trim().toLowerCase());
    if (match !== null && match[2] === domain) return match[1] as string;
  }
  return null;
}

export async function processInboundEmail(db: Database, media: MediaWriter, config: InboundEmailConfig, email: InboundEmail, now: Date): Promise<InboundOutcome> {
  const token = targetToken(email, config.domain);
  if (token === null) return { kind: 'ignored', reason: 'adresse_inconnue' };
  const target = await asSystem(db, (trx) =>
    trx
      .selectFrom('workspace_inbound_email as e')
      .innerJoin('workspaces as w', 'w.id', 'e.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .select(['e.workspace_id', 'w.status as workspace_status', 'o.status as org_status'])
      .where('e.token_hash', '=', hashToken(token))
      .executeTakeFirst(),
  );
  if (target === undefined || target.workspace_status !== 'active' || target.org_status === 'closed') return { kind: 'ignored', reason: 'adresse_inconnue' };
  const workspaceId = target.workspace_id;

  const messageHash = hashToken(email.messageId !== '' ? email.messageId : `${email.from}\n${email.subject}\n${email.text}`);
  const reserved = await asSystem(db, async (trx) => {
    await lockReference(trx, workspaceId, 'email', 'reception');
    await trx.deleteFrom('inbound_emails').where('workspace_id', '=', workspaceId).where('received_at', '<', new Date(now.getTime() - INBOUND_RETENTION_DAYS * 86_400_000)).execute();
    const recent = await trx
      .selectFrom('inbound_emails')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('outcome', '<>', 'ignored')
      .where('received_at', '>=', new Date(now.getTime() - 86_400_000))
      .executeTakeFirstOrThrow();
    const row = await trx
      .insertInto('inbound_emails')
      .values({ workspace_id: workspaceId, message_hash: messageHash, received_at: now })
      .onConflict((oc) => oc.columns(['workspace_id', 'message_hash']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return row === undefined ? null : { id: row.id, recent: Number(recent.n) };
  });
  if (reserved === null) return { kind: 'ignored', reason: 'doublon' };

  const finish = async (outcome: InboundOutcome): Promise<InboundOutcome> => {
    await asSystem(db, (trx) =>
      trx
        .updateTable('inbound_emails')
        .set({ outcome: outcome.kind, reason: outcome.kind === 'ignored' ? outcome.reason : null })
        .where('id', '=', reserved.id)
        .execute(),
    );
    return outcome;
  };

  try {
    if (email.spamScore !== null && email.spamScore >= INBOUND_SPAM_THRESHOLD) return await finish({ kind: 'ignored', reason: 'indesirable' });
    if (email.spfFailed) return await finish({ kind: 'ignored', reason: 'spf' });
    if (reserved.recent >= INBOUND_DAILY_LIMIT) return await finish({ kind: 'ignored', reason: 'limite' });

    const sender = normalizeEmail(email.from ?? '');
    const user = sender === null ? undefined : await asSystem(db, (trx) => trx.selectFrom('users').select('id').where('email', '=', sender).executeTakeFirst());
    if (user === undefined) return await finish({ kind: 'ignored', reason: 'expediteur_refuse' });

    const parsed = parseInboundSubject(email.subject);
    const title = parsed.title || (email.text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '');
    if (title === '') return await finish({ kind: 'ignored', reason: 'vide' });
    const link = firstLink(email.text);

    if (parsed.kind === 'request') {
      const held = await asSystem(db, (trx) =>
        trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', workspaceId).where('holder_user_id', '=', user.id).where('status', 'not in', ['revoked', 'paused']).execute(),
      );
      if (held.length > 0) {
        const id = await createPostRequest(db, media, user.id, workspaceId, { rawText: `${title}\n\n${email.text}`, title, links: link === null ? [] : [link], accountIds: held.map((a) => a.id) }, now);
        return await finish({ kind: 'request', id });
      }
    }
    // Sans compte dont l'expéditeur est titulaire, une demande reste une idée à trier.
    const id = await saveIdea(db, user.id, workspaceId, null, { title, details: email.text, link, accountIds: [] }, now);
    return await finish({ kind: 'idea', id });
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return finish({ kind: 'ignored', reason: 'expediteur_refuse' });
    if (error instanceof RefusedError) return finish({ kind: 'ignored', reason: error.code });
    // Erreur passagère : la réservation est retirée pour qu'un nouvel envoi soit traité.
    await asSystem(db, (trx) => trx.deleteFrom('inbound_emails').where('id', '=', reserved.id).execute());
    throw error;
  }
}

function sameSecret(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Réponse du webhook. Un e-mail écarté répond 200 : le renvoyer ne changerait rien. */
export async function handleInboundWebhook(
  db: Database,
  media: MediaWriter,
  config: InboundEmailConfig | null,
  presentedSecret: string,
  body: string,
  now: Date,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (config === null) return { status: 503, body: { error: 'Réception non configurée' } };
  if (!sameSecret(presentedSecret, config.webhookSecret)) return { status: 404, body: { error: 'Introuvable' } };
  if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) return { status: 413, body: { error: 'Trop volumineux' } };
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: 'JSON invalide' } };
  }
  let created = 0;
  let ignored = 0;
  for (const email of parseBrevoInbound(payload)) {
    const outcome = await processInboundEmail(db, media, config, email, now);
    if (outcome.kind === 'ignored') ignored += 1;
    else created += 1;
  }
  return { status: 200, body: { received: true, created, ignored } };
}

/**
 * Connexion par lien envoyé par e-mail, sans mot de passe (ONB-01, SEC-03).
 *
 * - Le lien est à usage unique et valable 15 minutes ; seule son empreinte est stockée.
 * - Les antivirus de messagerie ouvrent les liens reçus : le lien mène à une page qui
 *   demande de cliquer « Se connecter », et c'est ce clic qui consomme le jeton.
 * - La réponse est la même que l'adresse soit connue ou non (aucune énumération des comptes).
 * - Limite de débit : 5 liens par adresse et par quart d'heure (SEC-06).
 * - Session : jeton aléatoire dans un cookie, empreinte en base, 30 jours glissants,
 *   révocable.
 *
 * Ces tables sont réservées au système : tout passe par asSystem.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { addMinutes } from '@posts-auto/core';
import { type Database, type Tx, asSystem } from '@posts-auto/db';

export const LOGIN_LINK_TTL_MINUTES = 15;
export const LOGIN_LINKS_PER_WINDOW = 5;
export const LOGIN_RATE_WINDOW_MINUTES = 15;
export const SESSION_TTL_DAYS = 30;
/** Une session n'est prolongée qu'une fois par heure, pour éviter une écriture à chaque requête. */
const SESSION_TOUCH_MINUTES = 60;

/** Jeton aléatoire, sans caractère ambigu dans une URL. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  return EMAIL.test(trimmed) && trimmed.length <= 254 ? trimmed : null;
}

export type LoginLinkRequest =
  /** Lien à envoyer (l'adresse correspond à un utilisateur). */
  | { readonly kind: 'send'; readonly email: string; readonly token: string; readonly expiresAt: Date }
  /** Rien à envoyer ; l'interface affiche le même message que pour « send ». */
  | { readonly kind: 'silent' }
  /** Trop de demandes récentes pour cette adresse. */
  | { readonly kind: 'rate_limited' };

export async function requestLoginLink(db: Database, rawEmail: string, now: Date, ip?: string): Promise<LoginLinkRequest> {
  const email = normalizeEmail(rawEmail);
  if (email === null) return { kind: 'silent' };

  return asSystem(db, async (trx) => {
    const recent = await trx
      .selectFrom('login_tokens')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('email', '=', email)
      .where('created_at', '>', addMinutes(now, -LOGIN_RATE_WINDOW_MINUTES))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= LOGIN_LINKS_PER_WINDOW) return { kind: 'rate_limited' };

    const user = await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    const token = newToken();
    const expiresAt = addMinutes(now, LOGIN_LINK_TTL_MINUTES);
    // Le jeton est enregistré même pour une adresse inconnue : la limite de débit s'applique
    // pareil, et le temps de réponse ne trahit pas l'existence du compte.
    await trx
      .insertInto('login_tokens')
      .values({ token_hash: hashToken(token), email, expires_at: expiresAt, created_at: now, requested_ip: ip ?? null })
      .execute();
    return user === undefined ? { kind: 'silent' } : { kind: 'send', email, token, expiresAt };
  });
}

export interface SessionGrant {
  readonly userId: string;
  /** À poser dans un cookie HttpOnly, Secure, SameSite=Lax. */
  readonly sessionToken: string;
  readonly expiresAt: Date;
}

export type LoginOutcome = { readonly ok: true; readonly session: SessionGrant } | { readonly ok: false; readonly reason: 'invalid_or_expired' };

/** Consomme le lien (au clic sur « Se connecter ») et ouvre une session. */
export async function consumeLoginLink(
  db: Database,
  token: string,
  now: Date,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<LoginOutcome> {
  return asSystem(db, async (trx) => {
    const consumed = await trx
      .updateTable('login_tokens')
      .set({ used_at: now })
      .where('token_hash', '=', hashToken(token))
      .where('used_at', 'is', null)
      .where('expires_at', '>', now)
      .returning('email')
      .executeTakeFirst();
    if (consumed === undefined) return { ok: false, reason: 'invalid_or_expired' };

    const user = await trx.selectFrom('users').select('id').where('email', '=', consumed.email).executeTakeFirst();
    if (user === undefined) return { ok: false, reason: 'invalid_or_expired' };
    return { ok: true, session: await openSession(trx, user.id, now, meta) };
  });
}

/** Ouvre une session (30 jours glissants) dans la transaction système de l'appelant. */
export async function openSession(trx: Tx, userId: string, now: Date, meta: { ip?: string; userAgent?: string } = {}): Promise<SessionGrant> {
  const sessionToken = newToken();
  const expiresAt = addMinutes(now, SESSION_TTL_DAYS * 24 * 60);
  await trx
    .insertInto('sessions')
    .values({
      user_id: userId,
      token_hash: hashToken(sessionToken),
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 500) ?? null,
    })
    .execute();
  await trx.updateTable('users').set({ last_login_at: now }).where('id', '=', userId).execute();
  return { userId, sessionToken, expiresAt };
}

export interface ActiveSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

/** Identifie la personne derrière un cookie de session, et prolonge la session (30 jours glissants). */
export async function resolveSession(db: Database, sessionToken: string, now: Date): Promise<ActiveSession | null> {
  if (sessionToken.length < 20 || sessionToken.length > 100) return null;
  const hash = hashToken(sessionToken);
  return asSystem(db, async (trx) => {
    const session = await trx
      .selectFrom('sessions')
      .select(['id', 'user_id', 'token_hash', 'expires_at', 'last_seen_at'])
      .where('token_hash', '=', hash)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    // Comparaison à temps constant, par principe (la recherche par empreinte suffit déjà).
    if (session === undefined || !timingSafeEqual(Buffer.from(session.token_hash), Buffer.from(hash))) return null;

    let expiresAt = session.expires_at;
    if (now.getTime() - session.last_seen_at.getTime() > SESSION_TOUCH_MINUTES * 60_000) {
      expiresAt = addMinutes(now, SESSION_TTL_DAYS * 24 * 60);
      await trx.updateTable('sessions').set({ last_seen_at: now, expires_at: expiresAt }).where('id', '=', session.id).execute();
    }
    return { userId: session.user_id, sessionId: session.id, expiresAt };
  });
}

/** Déconnexion : la session ne vaut plus rien, même si le cookie est conservé. */
export async function revokeSession(db: Database, sessionToken: string, now: Date): Promise<void> {
  await asSystem(db, (trx) =>
    trx.updateTable('sessions').set({ revoked_at: now }).where('token_hash', '=', hashToken(sessionToken)).where('revoked_at', 'is', null).execute(),
  );
}

/** Déconnexion de tous les appareils d'une personne. */
export async function revokeAllSessions(db: Database, userId: string, now: Date): Promise<void> {
  await asSystem(db, (trx) =>
    trx.updateTable('sessions').set({ revoked_at: now }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute(),
  );
}

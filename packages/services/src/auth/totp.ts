/**
 * SEC-04 : double authentification par code à 6 chiffres (TOTP, RFC 6238), avec une
 * application d'authentification (Google Authenticator, Microsoft Authenticator, 1Password…).
 *
 * - Possible pour tous ; obligatoire pour les propriétaires et les administrateurs, avec
 *   MFA_GRACE_DAYS jours pour la mettre en place (à partir de la création du compte, ou de
 *   la mise en service de l'obligation pour les comptes plus anciens).
 * - Le secret est chiffré (SEC-02) ; un code ne sert qu'une fois (dernier pas mémorisé) ;
 *   tolérance d'un pas de 30 secondes de part et d'autre (horloge du téléphone).
 * - 10 codes de secours à usage unique, conservés par empreinte, montrés une seule fois.
 * - Après la connexion par lien, la session attend le code ; au 5e code faux, elle est
 *   révoquée (il faut redemander un lien).
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { sql } from 'kysely';
import type { TokenCrypto } from '../accounts/pages.ts';
import { RefusedError } from '../errors.ts';
import { hashToken } from './auth.ts';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const MFA_GRACE_DAYS = 7;
/** Mise en service de l'obligation : les comptes plus anciens ont leur délai à partir d'ici. */
export const MFA_ENFORCEMENT_START = new Date('2026-11-20T00:00:00Z');
export const MFA_MAX_FAILURES = 5;
export const RECOVERY_CODE_COUNT = 10;
const ISSUER = 'Posts LinkedIn';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
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
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('base32 invalide');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const stepOf = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);

function hotp(secret: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Code valable à cet instant (sert aussi aux tests et au test de fumée). */
export function totpCode(secretBase32: string, at: Date): string {
  return hotp(base32Decode(secretBase32), stepOf(at));
}

/** Pas accepté pour ce code (fenêtre ±1), ou null ; refuse un pas déjà utilisé. */
export function matchTotp(secret: Uint8Array, code: string, at: Date, lastStep: number): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const now = stepOf(at);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(digits))) return step;
  }
  return null;
}

export function otpauthUri(secretBase32: string, label: string): string {
  const params = new URLSearchParams({ secret: secretBase32, issuer: ISSUER, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(`${ISSUER}:${label}`)}?${params.toString()}`;
}

const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chars = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export interface MfaStatus {
  readonly enabled: boolean;
  /** Propriétaire ou administrateur d'au moins un espace. */
  readonly required: boolean;
  /** Date limite de mise en place, si obligatoire et pas encore faite. */
  readonly deadline: Date | null;
  readonly overdue: boolean;
}

export async function mfaStatus(db: Database, userId: string, now: Date): Promise<MfaStatus> {
  return asSystem(db, async (trx) => {
    const row = await trx
      .selectFrom('users as u')
      .leftJoin('user_totp as t', (join) => join.onRef('t.user_id', '=', 'u.id').on('t.confirmed_at', 'is not', null))
      .select([
        'u.created_at',
        't.user_id as totp',
        sql<boolean>`exists (select 1 from org_members o where o.user_id = u.id and o.role = 'owner') or exists (select 1 from workspace_members m where m.user_id = u.id and m.role = 'admin')`.as('required'),
      ])
      .where('u.id', '=', userId)
      .executeTakeFirstOrThrow();
    const enabled = row.totp !== null;
    if (enabled || !row.required) return { enabled, required: row.required, deadline: null, overdue: false };
    const from = Math.max(row.created_at.getTime(), MFA_ENFORCEMENT_START.getTime());
    const deadline = new Date(from + MFA_GRACE_DAYS * 86_400_000);
    return { enabled, required: true, deadline, overdue: now.getTime() >= deadline.getTime() };
  });
}

/** Début de la mise en place : nouveau secret (remplace une mise en place non confirmée). */
export async function startTotpSetup(db: Database, cipher: TokenCrypto, userId: string, now: Date): Promise<{ secret: string; uri: string }> {
  return asSystem(db, async (trx) => {
    const existing = await trx.selectFrom('user_totp').select('confirmed_at').where('user_id', '=', userId).executeTakeFirst();
    if (existing?.confirmed_at) throw new RefusedError('mfa_deja_active', 'La double authentification est déjà active.');
    const user = await trx.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow();
    const secret = base32Encode(randomBytes(20));
    const encrypted = Buffer.from(cipher.encrypt(secret, `totp:${userId}`));
    await trx
      .insertInto('user_totp')
      .values({ user_id: userId, secret_encrypted: encrypted, created_at: now })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({ secret_encrypted: encrypted, created_at: now, last_step: '0' }))
      .execute();
    return { secret, uri: otpauthUri(secret, user.email) };
  });
}

/** Mise en place commencée et pas encore confirmée : secret à afficher de nouveau. */
export async function pendingTotpSetup(db: Database, cipher: TokenCrypto, userId: string): Promise<{ secret: string; uri: string } | null> {
  return asSystem(db, async (trx) => {
    const row = await trx.selectFrom('user_totp as t').innerJoin('users as u', 'u.id', 't.user_id').select(['t.secret_encrypted', 't.confirmed_at', 'u.email']).where('t.user_id', '=', userId).executeTakeFirst();
    if (row === undefined || row.confirmed_at !== null) return null;
    const secret = cipher.decrypt(row.secret_encrypted, `totp:${userId}`);
    return { secret, uri: otpauthUri(secret, row.email) };
  });
}

/**
 * Confirmation par un premier code : active la double authentification, renvoie les codes
 * de secours (à montrer une seule fois) et marque la session courante comme vérifiée.
 */
export async function confirmTotpSetup(db: Database, cipher: TokenCrypto, userId: string, sessionId: string, code: string, now: Date): Promise<string[]> {
  return asSystem(db, async (trx) => {
    const row = await trx.selectFrom('user_totp').select(['secret_encrypted', 'confirmed_at', 'last_step']).where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (row === undefined) throw new RefusedError('mfa_non_commencee', 'Commencez par afficher le code à scanner.');
    if (row.confirmed_at !== null) throw new RefusedError('mfa_deja_active', 'La double authentification est déjà active.');
    const step = matchTotp(base32Decode(cipher.decrypt(row.secret_encrypted, `totp:${userId}`)), code, now, Number(row.last_step));
    if (step === null) throw new RefusedError('code_faux', 'Code incorrect. Vérifiez l’heure de votre téléphone et saisissez le code affiché.');
    await trx.updateTable('user_totp').set({ confirmed_at: now, last_step: String(step) }).where('user_id', '=', userId).execute();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await trx.deleteFrom('totp_recovery_codes').where('user_id', '=', userId).execute();
    await trx.insertInto('totp_recovery_codes').values(codes.map((c) => ({ user_id: userId, code_hash: hashToken(normalizeRecovery(c)) }))).execute();
    await trx.updateTable('sessions').set({ mfa_verified_at: now, mfa_failures: 0 }).where('id', '=', sessionId).execute();
    return codes;
  });
}

async function checkSecondFactor(
  trx: Parameters<Parameters<typeof asSystem>[1]>[0],
  cipher: TokenCrypto,
  userId: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const totp = await trx.selectFrom('user_totp').select(['secret_encrypted', 'last_step']).where('user_id', '=', userId).where('confirmed_at', 'is not', null).forUpdate().executeTakeFirst();
  if (totp === undefined) return false;
  const step = matchTotp(base32Decode(cipher.decrypt(totp.secret_encrypted, `totp:${userId}`)), code, now, Number(totp.last_step));
  if (step !== null) {
    await trx.updateTable('user_totp').set({ last_step: String(step) }).where('user_id', '=', userId).execute();
    return true;
  }
  const recovery = normalizeRecovery(code);
  if (recovery.length !== 10) return false;
  const used = await trx
    .updateTable('totp_recovery_codes')
    .set({ used_at: now })
    .where('user_id', '=', userId)
    .where('code_hash', '=', hashToken(recovery))
    .where('used_at', 'is', null)
    .returning('user_id')
    .executeTakeFirst();
  return used !== undefined;
}

export type MfaVerification = 'ok' | 'wrong' | 'revoked';

/** Code saisi après la connexion par lien (code de l'application ou code de secours). */
export async function verifySessionMfa(db: Database, cipher: TokenCrypto, sessionToken: string, code: string, now: Date): Promise<MfaVerification> {
  return asSystem(db, async (trx) => {
    const session = await trx
      .selectFrom('sessions')
      .select(['id', 'user_id', 'mfa_failures'])
      .where('token_hash', '=', hashToken(sessionToken))
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .forUpdate()
      .executeTakeFirst();
    if (session === undefined) return 'revoked';
    if (await checkSecondFactor(trx, cipher, session.user_id, code, now)) {
      await trx.updateTable('sessions').set({ mfa_verified_at: now, mfa_failures: 0 }).where('id', '=', session.id).execute();
      return 'ok';
    }
    const failures = session.mfa_failures + 1;
    await trx
      .updateTable('sessions')
      .set({ mfa_failures: failures, ...(failures >= MFA_MAX_FAILURES && { revoked_at: now }) })
      .where('id', '=', session.id)
      .execute();
    return failures >= MFA_MAX_FAILURES ? 'revoked' : 'wrong';
  });
}

/** Désactivation, avec un code valable ; refusée si elle est obligatoire pour la personne. */
export async function disableTotp(db: Database, cipher: TokenCrypto, userId: string, code: string, now: Date): Promise<void> {
  if ((await mfaStatus(db, userId, now)).required) throw new RefusedError('mfa_obligatoire', 'La double authentification est obligatoire pour les propriétaires et les administrateurs.');
  await asSystem(db, async (trx) => {
    if (!(await checkSecondFactor(trx, cipher, userId, code, now))) throw new RefusedError('code_faux', 'Code incorrect.');
    await trx.deleteFrom('user_totp').where('user_id', '=', userId).execute();
    await trx.deleteFrom('totp_recovery_codes').where('user_id', '=', userId).execute();
  });
}

/** Codes de secours restants. */
export async function remainingRecoveryCodes(db: Database, userId: string): Promise<number> {
  const row = await asSystem(db, (trx) =>
    trx.selectFrom('totp_recovery_codes').select(sql<number>`count(*)::int`.as('n')).where('user_id', '=', userId).where('used_at', 'is', null).executeTakeFirstOrThrow(),
  );
  return row.n;
}

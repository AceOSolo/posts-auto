import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consumeLoginLink,
  hashToken,
  normalizeEmail,
  requestLoginLink,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from './auth.js';

let db: Database;
let email: string;
let userId: string;
const NOW = new Date('2026-11-16T09:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeAll(async () => {
  db = await openTestDatabase();
  userId = await createUser(db, 'jp');
  const row = await asSystem(db, (trx) => trx.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow());
  email = row.email;
});
afterAll(() => closeTestDatabase(db));

async function loginLink(at = NOW): Promise<string> {
  const request = await requestLoginLink(db, email, at);
  if (request.kind !== 'send') throw new Error(`lien attendu, reçu ${request.kind}`);
  return request.token;
}

describe('lien de connexion (ONB-01, SEC-03)', () => {
  it('envoie un lien à une adresse connue, sans tenir compte de la casse ni des espaces', async () => {
    const request = await requestLoginLink(db, `  ${email.toUpperCase()} `, NOW);
    expect(request).toMatchObject({ kind: 'send', email, expiresAt: later(15) });
  });

  it('ne stocke que l’empreinte du jeton', async () => {
    const token = await loginLink();
    const stored = await asSystem(db, (trx) => trx.selectFrom('login_tokens').select('token_hash').execute());
    expect(stored.map((row) => row.token_hash)).toContain(hashToken(token));
    expect(stored.map((row) => row.token_hash)).not.toContain(token);
  });

  it('répond pareil pour une adresse inconnue ou invalide (aucune énumération des comptes)', async () => {
    expect(await requestLoginLink(db, 'inconnu@exemple.test', NOW)).toEqual({ kind: 'silent' });
    expect(await requestLoginLink(db, 'pas une adresse', NOW)).toEqual({ kind: 'silent' });
  });

  it('limite à 5 liens par adresse et par quart d’heure (SEC-06)', async () => {
    const target = 'limite@exemple.test';
    for (let i = 0; i < 5; i += 1) expect((await requestLoginLink(db, target, later(100))).kind).toBe('silent');
    expect(await requestLoginLink(db, target, later(100))).toEqual({ kind: 'rate_limited' });
    expect((await requestLoginLink(db, target, later(116))).kind).toBe('silent'); // fenêtre passée
  });

  it('ouvre une session au clic, une seule fois', async () => {
    const token = await loginLink(later(200));
    const outcome = await consumeLoginLink(db, token, later(201), { ip: '192.0.2.1', userAgent: 'Mobile Safari' });
    expect(outcome).toMatchObject({ ok: true, session: { userId } });
    expect(await consumeLoginLink(db, token, later(202))).toEqual({ ok: false, reason: 'invalid_or_expired' });
  });

  it('refuse un lien expiré ou inventé', async () => {
    const token = await loginLink(later(300));
    expect(await consumeLoginLink(db, token, later(316))).toEqual({ ok: false, reason: 'invalid_or_expired' });
    expect(await consumeLoginLink(db, 'jeton-invente', later(300))).toEqual({ ok: false, reason: 'invalid_or_expired' });
  });
});

describe('sessions (30 jours glissants, révocables)', () => {
  async function session(at: Date): Promise<string> {
    const outcome = await consumeLoginLink(db, await loginLink(at), at);
    if (!outcome.ok) throw new Error('connexion attendue');
    return outcome.session.sessionToken;
  }

  it('reconnaît la personne et prolonge la session à l’usage', async () => {
    const start = later(400);
    const token = await session(start);
    const twentyDaysLater = new Date(start.getTime() + 20 * 24 * 3_600_000);
    const resolved = await resolveSession(db, token, twentyDaysLater);
    expect(resolved?.userId).toBe(userId);
    expect(resolved?.expiresAt.toISOString()).toBe(new Date(twentyDaysLater.getTime() + 30 * 24 * 3_600_000).toISOString());
  });

  it('expire après 30 jours sans usage', async () => {
    const start = later(500);
    const token = await session(start);
    expect(await resolveSession(db, token, new Date(start.getTime() + 31 * 24 * 3_600_000))).toBeNull();
  });

  it('n’est plus valable après déconnexion, ni après « déconnecter tous les appareils »', async () => {
    const a = await session(later(600));
    const b = await session(later(600));
    await revokeSession(db, a, later(601));
    expect(await resolveSession(db, a, later(602))).toBeNull();
    expect(await resolveSession(db, b, later(602))).not.toBeNull();
    await revokeAllSessions(db, userId, later(603));
    expect(await resolveSession(db, b, later(604))).toBeNull();
  });

  it('ignore un cookie de forme invalide', async () => {
    expect(await resolveSession(db, 'court', NOW)).toBeNull();
  });
});

describe('adresses e-mail', () => {
  it('normalise ou rejette', () => {
    expect(normalizeEmail(' Jean.Dupont@Secutop.FR ')).toBe('jean.dupont@secutop.fr');
    expect(normalizeEmail('jean@')).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(250)}@x.fr`)).toBeNull();
  });
});

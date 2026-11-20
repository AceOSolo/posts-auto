import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmSignup, requestSignup } from '../onboarding/signup.ts';
import { consumeLoginLink, requestLoginLink, resolveSession } from './auth.ts';
import {
  MFA_GRACE_DAYS,
  base32Decode,
  base32Encode,
  confirmTotpSetup,
  disableTotp,
  matchTotp,
  mfaStatus,
  pendingTotpSetup,
  remainingRecoveryCodes,
  startTotpSetup,
  totpCode,
  verifySessionMfa,
} from './totp.ts';

let db: Database;
const NOW = new Date('2026-11-25T10:00:00Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
// Chiffrement de test : réversible, lié à la personne.
const cipher = {
  encrypt: (plaintext: string, boundTo: string) => Buffer.from(`${boundTo}|${plaintext}`),
  decrypt: (payload: Uint8Array, boundTo: string) => {
    const [bound, plaintext] = Buffer.from(payload).toString().split('|');
    if (bound !== boundTo) throw new Error('lié à une autre personne');
    return plaintext as string;
  },
};

async function login(email: string, at: Date) {
  const link = await requestLoginLink(db, email, at);
  if (link.kind !== 'send') throw new Error(link.kind);
  const outcome = await consumeLoginLink(db, link.token, at);
  if (!outcome.ok) throw new Error('connexion');
  return outcome.session.sessionToken;
}

beforeAll(async () => {
  db = await openTestDatabase();
});
afterAll(() => closeTestDatabase(db));

describe('TOTP (RFC 6238)', () => {
  it('vecteurs de la RFC 6238 (SHA-1, 6 derniers chiffres)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, new Date(59_000))).toBe('287082');
    expect(totpCode(secret, new Date(1_111_111_109_000))).toBe('081804');
    expect(totpCode(secret, new Date(2_000_000_000_000))).toBe('279037');
  });

  it('un pas de tolérance, un code ne sert qu’une fois', () => {
    const raw = Buffer.from('12345678901234567890');
    const secret = base32Encode(raw);
    const code = totpCode(secret, NOW);
    const step = matchTotp(raw, code, later(25), 0);
    expect(step).not.toBeNull();
    expect(matchTotp(raw, code, later(25), step as number)).toBeNull();
    expect(matchTotp(raw, code, later(95), 0)).toBeNull();
    expect(matchTotp(raw, 'abcdef', NOW, 0)).toBeNull();
  });
});

describe('double authentification (SEC-04)', () => {
  it('obligatoire pour un propriétaire après le délai ; facultative pour une contributrice', async () => {
    const request = await requestSignup(db, { email: 'mfa-owner@exemple.fr', fullName: 'Owner', orgName: 'MFA SARL', orgKind: 'entreprise' }, NOW);
    if (request.kind !== 'confirm') throw new Error(request.kind);
    const outcome = await confirmSignup(db, request.token, NOW);
    if (!outcome.ok) throw new Error('inscription');
    const status = await mfaStatus(db, outcome.session.userId, NOW);
    expect(status).toMatchObject({ enabled: false, required: true, overdue: false });
    expect(status.deadline).toEqual(new Date(NOW.getTime() + MFA_GRACE_DAYS * 86_400_000));
    expect((await mfaStatus(db, outcome.session.userId, later(MFA_GRACE_DAYS * 86_400))).overdue).toBe(true);

    const contributor = await createUser(db, 'contrib-mfa');
    await addMember(db, outcome.workspaceId, contributor, 'contributor');
    expect(await mfaStatus(db, contributor, later(30 * 86_400))).toMatchObject({ required: false, overdue: false, deadline: null });
  });

  it('mise en place, connexion avec code, code de secours, révocation au 5e essai', async () => {
    const userId = await asSystem(db, async (trx) =>
      (await trx.insertInto('users').values({ email: 'mfa-user@exemple.fr', full_name: 'Utilisatrice' }).returning('id').executeTakeFirstOrThrow()).id,
    );
    const first = await login('mfa-user@exemple.fr', NOW);
    const session = await resolveSession(db, first, NOW);
    expect(session?.mfaPending).toBe(false);

    const { secret, uri } = await startTotpSetup(db, cipher, userId, NOW);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Rostra%3Amfa-user%40exemple\.fr\?secret=/);
    expect((await pendingTotpSetup(db, cipher, userId))?.secret).toBe(secret);
    await expect(confirmTotpSetup(db, cipher, userId, session?.sessionId as string, '000000', NOW)).rejects.toMatchObject({ code: 'code_faux' });
    const recovery = await confirmTotpSetup(db, cipher, userId, session?.sessionId as string, totpCode(secret, NOW), NOW);
    expect(recovery).toHaveLength(10);
    expect(await pendingTotpSetup(db, cipher, userId)).toBeNull();
    // La session où la mise en place a été faite reste ouverte.
    expect((await resolveSession(db, first, NOW))?.mfaPending).toBe(false);

    // Nouvelle connexion : le code est demandé.
    const second = await login('mfa-user@exemple.fr', later(60));
    expect((await resolveSession(db, second, later(60)))?.mfaPending).toBe(true);
    expect(await verifySessionMfa(db, cipher, second, '123456', later(61))).toBe('wrong');
    expect(await verifySessionMfa(db, cipher, second, totpCode(secret, later(90)), later(90))).toBe('ok');
    expect((await resolveSession(db, second, later(91)))?.mfaPending).toBe(false);

    // Code de secours : une seule fois.
    const third = await login('mfa-user@exemple.fr', later(120));
    expect(await verifySessionMfa(db, cipher, third, (recovery[0] as string).toUpperCase(), later(121))).toBe('ok');
    expect(await remainingRecoveryCodes(db, userId)).toBe(9);
    const fourth = await login('mfa-user@exemple.fr', later(150));
    expect(await verifySessionMfa(db, cipher, fourth, recovery[0] as string, later(151))).toBe('wrong');

    // Cinq codes faux : la session est révoquée.
    const fifth = await login('mfa-user@exemple.fr', later(180));
    for (let i = 0; i < 4; i += 1) expect(await verifySessionMfa(db, cipher, fifth, '000000', later(181))).toBe('wrong');
    expect(await verifySessionMfa(db, cipher, fifth, '000000', later(182))).toBe('revoked');
    expect(await resolveSession(db, fifth, later(183))).toBeNull();

    // Désactivation avec un code valable (facultative pour cette personne).
    await expect(disableTotp(db, cipher, userId, '000000', later(300))).rejects.toMatchObject({ code: 'code_faux' });
    await disableTotp(db, cipher, userId, totpCode(secret, later(300)), later(300));
    expect((await mfaStatus(db, userId, later(300))).enabled).toBe(false);
  });
});

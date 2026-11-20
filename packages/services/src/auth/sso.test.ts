import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSession } from './auth.ts';
import { SsoError, completeSsoLogin, googleProvider, microsoftProvider, pkcePair } from './sso.ts';

let db: Database;
beforeAll(async () => {
  db = await openTestDatabase();
  await asSystem(db, (trx) => trx.insertInto('users').values({ email: 'sso@exemple.fr', full_name: 'SSO' }).execute());
});
afterAll(() => closeTestDatabase(db));

const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const tokenEndpoint = (claims: Record<string, unknown>, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify({ id_token: idToken(claims) }), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const future = Math.floor(Date.now() / 1000) + 600;

describe('connexion Google et Microsoft (ONB-01)', () => {
  it('PKCE : défi S256 du vérificateur', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).not.toBe(verifier);
  });

  it('Google : adresse vérifiée seulement ; jeton d’une autre application refusé', async () => {
    const ok = googleProvider('client-g', 's', tokenEndpoint({ iss: 'https://accounts.google.com', aud: 'client-g', exp: future, sub: '1', email: 'sso@exemple.fr', email_verified: true }));
    expect(await ok.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })).toEqual({ email: 'sso@exemple.fr', subject: '1' });
    const unverified = googleProvider('client-g', 's', tokenEndpoint({ iss: 'https://accounts.google.com', aud: 'client-g', exp: future, sub: '1', email: 'sso@exemple.fr', email_verified: false }));
    expect((await unverified.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })).email).toBeNull();
    const other = googleProvider('client-g', 's', tokenEndpoint({ iss: 'https://accounts.google.com', aud: 'autre', exp: future, sub: '1' }));
    await expect(other.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })).rejects.toBeInstanceOf(SsoError);
    expect(ok.authorizeUrl({ state: 's1', codeChallenge: 'ch', redirectUri: 'https://app/retour' })).toMatch(/code_challenge=ch&code_challenge_method=S256/);
  });

  it('Microsoft : adresse retenue seulement si le domaine est vérifié (xms_edov)', async () => {
    const iss = 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0';
    const verified = microsoftProvider('client-m', 's', tokenEndpoint({ iss, aud: 'client-m', exp: future, sub: '2', email: 'sso@exemple.fr', xms_edov: true }));
    expect((await verified.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })).email).toBe('sso@exemple.fr');
    const plain = microsoftProvider('client-m', 's', tokenEndpoint({ iss, aud: 'client-m', exp: future, sub: '2', email: 'sso@exemple.fr' }));
    expect((await plain.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'r' })).email).toBeNull();
  });

  it('session ouverte pour un compte existant seulement', async () => {
    const outcome = await completeSsoLogin(db, { email: 'SSO@exemple.fr' }, new Date());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect((await resolveSession(db, outcome.session.sessionToken, new Date()))?.mfaPending).toBe(false);
    expect(await completeSsoLogin(db, { email: 'inconnu@exemple.fr' }, new Date())).toEqual({ ok: false, reason: 'compte_inconnu' });
    expect(await completeSsoLogin(db, { email: null }, new Date())).toEqual({ ok: false, reason: 'adresse_non_verifiee' });
  });
});

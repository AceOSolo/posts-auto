import { randomBytes } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { LinkedInError, type LinkedInOAuth, type MemberProfile, type TokenSet } from '@posts-auto/linkedin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenCipher } from '../secrets/token-cipher.ts';
import { runTokenCheck } from './token-check.ts';

let db: Database;
const k1 = randomBytes(32);
const cipher = new TokenCipher(new Map([['k1', k1]]), 'k1');
const NOW = new Date('2026-11-16T05:00:00Z');
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const authError = (status: number) => new LinkedInError({ kind: 'auth', phase: 'image_upload', outcome: 'not_created', status, message: 'refusé' });

/** LinkedIn simulé : renouvellement et vérification réglables. */
class StubOAuth implements LinkedInOAuth {
  readonly clientId = 'app-a';
  refreshes: string[] = [];
  checks: string[] = [];
  refreshFails = false;
  profileStatus: number | null = null;
  authorizationUrl(): string {
    return '';
  }
  async exchangeCode(): Promise<TokenSet> {
    throw new Error('non utilisé');
  }
  async refresh(refreshToken: string, now: Date): Promise<TokenSet> {
    this.refreshes.push(refreshToken);
    if (this.refreshFails) throw authError(400);
    return { accessToken: 'AT-NOUVEAU', expiresAt: new Date(now.getTime() + 60 * 86_400_000), refreshToken: null, refreshExpiresAt: null, scopes: [] };
  }
  async memberProfile(accessToken: string): Promise<MemberProfile> {
    this.checks.push(accessToken);
    if (this.profileStatus !== null) throw authError(this.profileStatus);
    return { sub: 'x', urn: 'urn:li:person:x', name: 'X', pictureUrl: null };
  }
}

let workspaceId: string;
let holderId: string;
let adminId: string;

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  holderId = await createUser(db, 'titulaire');
  adminId = await createUser(db, 'admin');
  await addMember(db, workspaceId, holderId, 'contributor');
  await addMember(db, workspaceId, adminId, 'admin');
});
afterAll(() => closeTestDatabase(db));

/** Un compte connecté, seul dans sa base « logique » (les autres comptes du fichier sont mis en pause). */
async function connected(token: { expiresInDays: number; refreshInDays?: number; checkedHoursAgo?: number; key?: TokenCipher }) {
  await asSystem(db, (trx) => trx.updateTable('social_accounts').set({ status: 'paused' }).where('workspace_id', '=', workspaceId).execute());
  const accountId = await createAccount(db, workspaceId, { holder_user_id: holderId, display_name: 'JP' });
  const key = token.key ?? cipher;
  await asSystem(db, (trx) =>
    trx
      .insertInto('social_tokens')
      .values({
        account_id: accountId,
        workspace_id: workspaceId,
        oauth_client_id: 'app-a',
        access_token_enc: key.encrypt('AT-ANCIEN', accountId),
        refresh_token_enc: token.refreshInDays === undefined ? null : key.encrypt('RT', accountId),
        scopes: ['w_member_social'],
        expires_at: inDays(token.expiresInDays),
        refresh_expires_at: token.refreshInDays === undefined ? null : inDays(token.refreshInDays),
        last_checked_at: token.checkedHoursAgo === undefined ? null : new Date(NOW.getTime() - token.checkedHoursAgo * 3_600_000),
      })
      .execute(),
  );
  return accountId;
}

const state = (accountId: string) =>
  asSystem(db, async (trx) => ({
    account: await trx.selectFrom('social_accounts').select('status').where('id', '=', accountId).executeTakeFirstOrThrow(),
    token: await trx.selectFrom('social_tokens').selectAll().where('account_id', '=', accountId).executeTakeFirstOrThrow(),
    alerts: await trx
      .selectFrom('notifications')
      .select(['user_id', 'kind', 'channel', 'payload'])
      .where('workspace_id', '=', workspaceId)
      .where('kind', 'like', 'connexion_%')
      .execute(),
  }));

async function clearNotifications() {
  await asSystem(db, (trx) => trx.deleteFrom('notifications').where('workspace_id', '=', workspaceId).execute());
}

describe('surveillance des connexions LinkedIn (LNK-04)', () => {
  it('à 10 jours de l’échéance : « expire bientôt », alerte au titulaire et à l’admin, une seule fois', async () => {
    await clearNotifications();
    const accountId = await connected({ expiresInDays: 10 });
    const oauth = new StubOAuth();
    const report = await runTokenCheck({ db, oauth, cipher, clock: () => NOW });
    expect(report.alerts).toEqual([`${accountId}:j14`]);
    const after = await state(accountId);
    expect(after.account.status).toBe('expiring');
    expect(new Set(after.alerts.map((a) => a.user_id))).toEqual(new Set([holderId, adminId, expect.any(String)]));
    expect(after.alerts[0]).toMatchObject({ kind: 'connexion_expire_bientot', payload: { daysLeft: 10, accountName: 'JP' } });

    expect((await runTokenCheck({ db, oauth, cipher, clock: () => inDays(1) })).alerts).toEqual([]);
  });

  it('découverte à 2 jours : seule l’alerte J-3 part, puis J0 à l’expiration', async () => {
    await clearNotifications();
    const accountId = await connected({ expiresInDays: 2 });
    const oauth = new StubOAuth();
    expect((await runTokenCheck({ db, oauth, cipher, clock: () => NOW })).alerts).toEqual([`${accountId}:j3`]);
    const later = await runTokenCheck({ db, oauth, cipher, clock: () => inDays(3) });
    expect(later.alerts).toEqual([`${accountId}:j0`]);
    expect(later.expired).toContain(accountId);
    const after = await state(accountId);
    expect(after.account.status).toBe('expired');
    expect(after.token.expiry_alerts_sent.sort()).toEqual(['j0', 'j14', 'j3']);
  });

  it('avec un jeton de renouvellement : renouvelle à 7 jours de l’échéance, sans alerte', async () => {
    await clearNotifications();
    const accountId = await connected({ expiresInDays: 5, refreshInDays: 300 });
    const oauth = new StubOAuth();
    const report = await runTokenCheck({ db, oauth, cipher, clock: () => NOW });
    expect(report.refreshed).toEqual([accountId]);
    expect(report.alerts).toEqual([]);
    expect(oauth.refreshes).toEqual(['RT']);
    const after = await state(accountId);
    expect(cipher.decrypt(after.token.access_token_enc, accountId)).toBe('AT-NOUVEAU');
    expect(after.token.expires_at.toISOString()).toBe(inDays(60).toISOString());
    expect(after.account.status).toBe('connected');
  });

  it('l’échéance qui compte est celle du jeton de renouvellement (alerte à J-14 avant sa fin)', async () => {
    await clearNotifications();
    const accountId = await connected({ expiresInDays: 30, refreshInDays: 12, checkedHoursAgo: 1 });
    expect((await runTokenCheck({ db, oauth: new StubOAuth(), cipher, clock: () => NOW })).alerts).toEqual([`${accountId}:j14`]);
  });

  it('renouvellement refusé par LinkedIn : connexion expirée, alerte immédiate', async () => {
    await clearNotifications();
    const accountId = await connected({ expiresInDays: 5, refreshInDays: 300 });
    const oauth = new StubOAuth();
    oauth.refreshFails = true;
    const report = await runTokenCheck({ db, oauth, cipher, clock: () => NOW });
    expect(report.expired).toEqual([accountId]);
    expect(report.alerts).toEqual([`${accountId}:j0`]);
  });

  it('jeton révoqué côté LinkedIn (vérification 401) : connexion expirée (CM-002, CM-003)', async () => {
    await clearNotifications();
    const accountId = await connected({ expiresInDays: 40 });
    const oauth = new StubOAuth();
    oauth.profileStatus = 401;
    const report = await runTokenCheck({ db, oauth, cipher, clock: () => NOW });
    expect(oauth.checks).toEqual(['AT-ANCIEN']);
    expect(report.expired).toEqual([accountId]);
    expect((await state(accountId)).alerts[0]).toMatchObject({ kind: 'connexion_expiree', payload: { revoked: true } });
  });

  it('LinkedIn momentanément indisponible : rien ne change, nouvel essai au prochain passage', async () => {
    await clearNotifications();
    const accountId = await connected({ expiresInDays: 40 });
    const oauth = new StubOAuth();
    oauth.profileStatus = 503;
    const report = await runTokenCheck({ db, oauth, cipher, clock: () => NOW });
    expect(report.expired).toEqual([]);
    expect((await state(accountId)).token.last_checked_at).toBeNull();
  });

  it('ne revérifie pas un jeton contrôlé il y a moins de 20 heures', async () => {
    await connected({ expiresInDays: 40, checkedHoursAgo: 5 });
    const oauth = new StubOAuth();
    await runTokenCheck({ db, oauth, cipher, clock: () => NOW });
    expect(oauth.checks).toEqual([]);
  });

  it('sans application LinkedIn configurée : alertes seulement, aucun appel', async () => {
    await clearNotifications();
    const accountId = await connected({ expiresInDays: 10, refreshInDays: 300 });
    const report = await runTokenCheck({ db, oauth: null, cipher, clock: () => NOW });
    expect(report.refreshed).toEqual([]);
    expect(report.alerts).toEqual([`${accountId}:j14`]);
  });

  it('rechiffre les jetons avec la nouvelle clé après une rotation (SEC-02)', async () => {
    const accountId = await connected({ expiresInDays: 40, refreshInDays: 300, checkedHoursAgo: 1 });
    const rotated = new TokenCipher(new Map([['k1', k1], ['k2', randomBytes(32)]]), 'k2');
    const report = await runTokenCheck({ db, oauth: new StubOAuth(), cipher: rotated, clock: () => NOW });
    expect(report.reencrypted).toEqual([accountId]);
    const after = await state(accountId);
    expect(rotated.needsReencryption(after.token.access_token_enc)).toBe(false);
    expect(rotated.decrypt(after.token.access_token_enc, accountId)).toBe('AT-ANCIEN');
    expect(rotated.decrypt(after.token.refresh_token_enc as Buffer, accountId)).toBe('RT');
  });
});

import { randomBytes } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createOrganization, createPost, openTestDatabase } from '@posts-auto/db/testing';
import { FakeLinkedInStats, type LinkedInStats } from '@posts-auto/linkedin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenCipher } from '../secrets/token-cipher.ts';
import { runStatsTick } from './stats-job.ts';

let db: Database;
const cipher = new TokenCipher(new Map([['k1', randomBytes(32)]]), 'k1');
const NOW = new Date('2026-11-20T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

beforeAll(async () => {
  db = await openTestDatabase();
});
afterAll(() => closeTestDatabase(db));

async function connected(kind: 'profile' | 'page') {
  const org = await createOrganization(db);
  const workspaceId = org.workspaceIds[0] as string;
  const accountId = await createAccount(db, workspaceId, { kind, external_urn: kind === 'page' ? `urn:li:organization:${Date.now()}` : `urn:li:person:${Date.now()}` });
  await asSystem(db, (trx) =>
    trx
      .insertInto('social_tokens')
      .values({ account_id: accountId, workspace_id: workspaceId, oauth_client_id: 'app-a', access_token_enc: cipher.encrypt('TOKEN', accountId), scopes: [], expires_at: new Date(NOW.getTime() + 30 * 86_400_000) })
      .execute(),
  );
  return { workspaceId, accountId };
}

describe('statistiques LinkedIn (SUI-03)', () => {
  it('relevé à J+1 et J+7, une seule fois ; abonnés des pages une fois par jour', async () => {
    const { workspaceId, accountId } = await connected('page');
    const old = await createPost(db, workspaceId, accountId, { status: 'publie', scheduled_at: daysAgo(8), published_at: daysAgo(8), external_post_urn: 'urn:li:share:8' });
    const fresh = await createPost(db, workspaceId, accountId, { status: 'publie', scheduled_at: daysAgo(1.5), published_at: daysAgo(1.5), external_post_urn: 'urn:li:share:1' });
    const report = await runStatsTick({ db, stats: new FakeLinkedInStats(), cipher, clock: () => NOW });
    expect(report).toMatchObject({ captured: 2, unavailable: 0, followers: 1, errors: 0 });
    const rows = await asSystem(db, (trx) => trx.selectFrom('post_stats').select(['post_id', 'day_offset', 'available']).where('workspace_id', '=', workspaceId).orderBy('post_id').execute());
    expect(rows).toEqual(expect.arrayContaining([{ post_id: old, day_offset: 7, available: true }, { post_id: fresh, day_offset: 1, available: true }]));
    expect(await runStatsTick({ db, stats: new FakeLinkedInStats(), cipher, clock: () => NOW })).toMatchObject({ captured: 0, followers: 0 });
  });

  it('statistique refusée par LinkedIn : notée indisponible, rien d’inventé', async () => {
    const { workspaceId, accountId } = await connected('profile');
    await createPost(db, workspaceId, accountId, { status: 'publie', scheduled_at: daysAgo(2), published_at: daysAgo(2), external_post_urn: 'urn:li:share:2' });
    const none: LinkedInStats = { postStats: async () => null, followers: async () => null };
    expect(await runStatsTick({ db, stats: none, cipher, clock: () => NOW })).toMatchObject({ captured: 0, unavailable: 1 });
    const row = await asSystem(db, (trx) => trx.selectFrom('post_stats').selectAll().where('workspace_id', '=', workspaceId).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ available: false, impressions: null, reactions: null });
  });
});

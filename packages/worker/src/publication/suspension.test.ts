/** Suspension décidée par l'éditeur : aucun envoi à LinkedIn tant qu'elle dure. */
import { randomBytes } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { FakeLinkedIn } from '@posts-auto/linkedin';
import { reactivateOrganization, suspendOrganization } from '@posts-auto/services';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueWorkspaces } from '../generation/weekly.ts';
import { MemoryMediaStore } from '../media/media-store.ts';
import { TokenCipher } from '../secrets/token-cipher.ts';
import { runPublicationTick } from './publication.ts';

let db: Database;
let admin: string;
const cipher = new TokenCipher(new Map([['k1', randomBytes(32)]]), 'k1');
const NOON = new Date('2026-11-17T11:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  admin = await createUser(db, 'editeur');
  await asSystem(db, async (trx) => {
    await trx.insertInto('platform_admins').values({ user_id: admin }).execute();
    await trx.insertInto('user_totp').values({ user_id: admin, secret_encrypted: Buffer.from('x'), confirmed_at: NOON }).execute();
  });
});
afterAll(() => closeTestDatabase(db));

async function connected() {
  const org = await createOrganization(db);
  const workspaceId = org.workspaceIds[0] as string;
  const accountId = await createAccount(db, workspaceId, { status: 'connected' });
  await asSystem(db, (trx) =>
    trx
      .insertInto('social_tokens')
      .values({ account_id: accountId, workspace_id: workspaceId, oauth_client_id: 'app-a', access_token_enc: cipher.encrypt(`TOKEN-${accountId}`, accountId), scopes: ['w_member_social'], expires_at: new Date(NOON.getTime() + 50 * 86_400_000) })
      .execute(),
  );
  return { orgId: org.orgId, workspaceId, accountId };
}

const statusOf = async (postId: string) => (await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', postId).executeTakeFirstOrThrow())).status;

describe('suspension de l’éditeur', () => {
  it('retient un post validé et une nouvelle tentative, qui repartent à la réactivation', async () => {
    const s = await connected();
    const linkedin = new FakeLinkedIn();
    const deps = { db, linkedin, media: new MemoryMediaStore(), cipher, clock: () => NOON };
    const validated = await createPost(db, s.workspaceId, s.accountId, { status: 'valide', scheduled_at: NOON });
    const retrying = await createPost(db, s.workspaceId, s.accountId, { status: 'en_publication', scheduled_at: new Date(NOON.getTime() - 60_000), next_publish_attempt_at: NOON, publish_retries_left: 2 });

    await suspendOrganization(db, admin, s.orgId, 'Contrôle en cours', NOON);
    const held = await runPublicationTick(deps);
    expect(held.published).toEqual([]);
    expect(held.started).toEqual([]);
    expect(await statusOf(validated)).toBe('valide');
    expect(await statusOf(retrying)).toBe('en_publication');

    await reactivateOrganization(db, admin, s.orgId, NOON);
    const released = await runPublicationTick(deps);
    expect(released.published.sort()).toEqual([validated, retrying].sort());
  });

  it('ne déclenche pas de rédaction', async () => {
    const s = await connected();
    await asSystem(db, (trx) => trx.updateTable('workspaces').set({ generation_requested_at: NOON }).where('id', '=', s.workspaceId).execute());
    expect(await dueWorkspaces(db, NOON)).toContain(s.workspaceId);
    await suspendOrganization(db, admin, s.orgId, 'Contrôle en cours', NOON);
    expect(await dueWorkspaces(db, NOON)).not.toContain(s.workspaceId);
  });
});

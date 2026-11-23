import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAutoValidationTick } from './auto-validate.ts';

const NOW = new Date('2026-11-23T08:00:00Z');
const LATER = new Date('2026-11-24T11:00:00Z');

let db: Database;
let workspaceId: string;
let holderId: string;

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  holderId = await createUser(db, 'titulaire-auto');
});
afterAll(() => closeTestDatabase(db));

async function account(options: { consent?: boolean; consentBy?: string; publishMode?: string; status?: string } = {}) {
  const id = await createAccount(db, workspaceId, { holder_user_id: holderId, status: options.status ?? 'connected', publish_mode: options.publishMode ?? 'auto' });
  if (options.consent !== false) {
    await asSystem(db, (trx) =>
      trx.insertInto('account_consents').values({ workspace_id: workspaceId, account_id: id, user_id: options.consentBy ?? holderId, kind: 'auto_validate', text_version: 'test', granted_at: NOW }).execute(),
    );
  }
  return id;
}

const post = (accountId: string, values: Parameters<typeof createPost>[3] = {}) => createPost(db, workspaceId, accountId, { scheduled_at: LATER, ...values });
const statusOf = async (postId: string) => (await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', postId).executeTakeFirstOrThrow())).status;
const tick = () => runAutoValidationTick({ db, clock: () => NOW });

describe('publier sans me demander (VAL-11)', () => {
  it('valide un post rédigé par l’IA, trace la décision comme venant du système, une seule fois', async () => {
    const postId = await post(await account());
    expect((await tick()).validated).toContain(postId);
    expect(await statusOf(postId)).toBe('valide');
    const row = await asSystem(db, (trx) => trx.selectFrom('posts').select('decided_by').where('id', '=', postId).executeTakeFirstOrThrow());
    expect(row.decided_by).toBeNull();
    const history = await asSystem(db, (trx) => trx.selectFrom('post_status_history').select(['actor_kind', 'reason']).where('post_id', '=', postId).execute());
    expect(history).toEqual([{ actor_kind: 'system', reason: expect.stringContaining('publier sans me demander') }]);
    expect((await tick()).validated).not.toContain(postId);
  });

  it('ne touche pas un compte sans accord, ni un accord donné par quelqu’un d’autre que le titulaire', async () => {
    const other = await createUser(db, 'autre-personne');
    const without = await post(await account({ consent: false }));
    const wrongPerson = await post(await account({ consentBy: other }));
    await tick();
    expect(await statusOf(without)).toBe('a_valider');
    expect(await statusOf(wrongPerson)).toBe('a_valider');
  });

  it('laisse à valider ce qui demande une relecture', async () => {
    const id = await account();
    const marker = await post(id, { body: 'Webinaire le [À COMPLÉTER : date].', scheduled_at: new Date('2026-11-24T12:00:00Z') });
    const article = await post(id, { origin: 'external_source', scheduled_at: new Date('2026-11-24T13:00:00Z') });
    const request = await post(id, { origin: 'request', scheduled_at: new Date('2026-11-24T14:00:00Z') });
    const idea = await post(id, { origin: 'team_idea', scheduled_at: new Date('2026-11-24T15:00:00Z') });
    const rework = await post(id, { version_no: 2, scheduled_at: new Date('2026-11-24T16:00:00Z') });
    const past = await post(id, { scheduled_at: new Date('2026-11-22T12:00:00Z') });
    await tick();
    for (const postId of [marker, article, request, idea, rework, past]) expect(await statusOf(postId)).toBe('a_valider');
  });

  it('respecte un retrait de validation : une personne a repris la main', async () => {
    const postId = await post(await account());
    await asSystem(db, (trx) =>
      trx.insertInto('post_status_history').values({ workspace_id: workspaceId, post_id: postId, from_status: 'valide', to_status: 'a_valider', actor_kind: 'user', actor_user_id: holderId, at: NOW }).execute(),
    );
    await tick();
    expect(await statusOf(postId)).toBe('a_valider');
  });

  it('laisse à valider un texte corrigé par une personne', async () => {
    const postId = await post(await account());
    await asSystem(db, async (trx) => {
      const version = await trx.insertInto('post_versions').values({ workspace_id: workspaceId, post_id: postId, revision: 2, body: 'Corrigé.', author_kind: 'user', author_user_id: holderId }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('posts').set({ current_version_id: version.id }).where('id', '=', postId).execute();
    });
    await tick();
    expect(await statusOf(postId)).toBe('a_valider');
  });

  it('ne valide rien sur un compte en pause ou déconnecté, ni avec un visuel en préparation', async () => {
    const paused = await post(await account({ publishMode: 'manual' }));
    const expired = await post(await account({ status: 'expired' }));
    const withTask = await post(await account());
    await asSystem(db, (trx) => trx.insertInto('visual_tasks').values({ post_id: withTask, workspace_id: workspaceId, reason: 'redo' }).execute());
    await tick();
    for (const postId of [paused, expired, withTask]) expect(await statusOf(postId)).toBe('a_valider');
  });
});

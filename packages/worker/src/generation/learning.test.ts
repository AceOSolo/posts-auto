import { FakeModel } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLearningTick } from './learning.ts';

let db: Database;
let workspaceId: string;
let holder: string;
const NOW = new Date('2026-11-16T03:00:00Z');
let slot = 0;

async function correctedPost(accountId: string, before: string, after: string): Promise<void> {
  const postId = await createPost(db, workspaceId, accountId, { body: before, scheduled_at: new Date(Date.UTC(2026, 10, 2 + (slot += 1), 11)) });
  await asSystem(db, async (trx) => {
    const v = await trx
      .insertInto('post_versions')
      .values({ workspace_id: workspaceId, post_id: postId, revision: 2, body: after, author_kind: 'user', author_user_id: holder, created_at: new Date('2026-11-10T10:00:00Z') })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.updateTable('posts').set({ current_version_id: v.id }).where('id', '=', postId).execute();
  });
}

async function refused(accountId: string, reason: string): Promise<void> {
  const postId = await createPost(db, workspaceId, accountId, { scheduled_at: new Date(Date.UTC(2026, 10, 2 + (slot += 1), 11)) });
  await asSystem(db, (trx) =>
    trx
      .insertInto('post_status_history')
      .values({ workspace_id: workspaceId, post_id: postId, from_status: 'a_valider', to_status: 'refuse', actor_kind: 'user', actor_user_id: holder, reason, at: new Date('2026-11-11T10:00:00Z') })
      .execute(),
  );
}

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  holder = await createUser(db, 'titulaire');
});
afterAll(() => closeTestDatabase(db));

describe('apprentissage des préférences (EDI-06)', () => {
  it('à partir de 3 signaux, le résumé est mis à jour en partant de l’actuel ; rien de plus sans nouveau signal', async () => {
    const account = await createAccount(db, workspaceId, { display_name: 'Jean-Pierre', holder_user_id: holder });
    await asSystem(db, (trx) => trx.insertInto('learned_preferences').values({ account_id: account, workspace_id: workspaceId, summary: 'Pas d’emoji.', edited_by: holder }).execute());
    await correctedPost(account, 'Nous sommes ravis de vous annoncer une formidable nouvelle !', 'Une nouvelle formation ouvre en janvier.');
    await correctedPost(account, 'Il convient de souligner que la prévention est essentielle.', 'La prévention, c’est essentiel.');
    await refused(account, 'ton_inadapte : trop commercial');

    const model = new FakeModel(() => ({ summary: 'Pas d’emoji.\nPhrases courtes.\nPas de ton commercial.', changes: ['Ajout : phrases courtes'] }));
    const first = await runLearningTick({ db, model, clock: () => NOW });
    expect(first.updated).toEqual([account]);
    expect(model.calls[0]?.purpose).toBe('learn');
    expect(model.calls[0]?.context).toContain('Résumé actuel :\nPas d’emoji.');
    expect(model.calls[0]?.task).toContain('Texte corrigé par la personne :\nLa prévention, c’est essentiel.');
    expect(model.calls[0]?.task).toContain('<document type="refus" id="decision-1">\nton_inadapte : trop commercial');

    const prefs = await asSystem(db, (trx) => trx.selectFrom('learned_preferences').select(['summary', 'learned_until', 'edited_by']).where('account_id', '=', account).executeTakeFirstOrThrow());
    expect(prefs).toEqual({ summary: 'Pas d’emoji.\nPhrases courtes.\nPas de ton commercial.', learned_until: NOW, edited_by: null });
    const usage = await asSystem(db, (trx) => trx.selectFrom('ai_usage').select(['purpose', 'counted_in_quota']).where('account_id', '=', account).execute());
    expect(usage).toEqual([{ purpose: 'learn', counted_in_quota: false }]);

    const again = await runLearningTick({ db, model, clock: () => new Date(NOW.getTime() + 3_600_000) });
    expect(again.updated).not.toContain(account);
    expect(model.calls).toHaveLength(1);
  });

  it('moins de 3 signaux : pas de mise à jour', async () => {
    const account = await createAccount(db, workspaceId, { display_name: 'Claire', holder_user_id: holder });
    await refused(account, 'deja_traite');
    const model = new FakeModel(() => ({ summary: 'x', changes: [] }));
    expect((await runLearningTick({ db, model, clock: () => NOW })).updated).not.toContain(account);
  });
});

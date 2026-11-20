/** ONB-06 : la rédaction d'un espace en essai gratuit s'arrête à 10 posts et à la fin de l'essai. */
import { FakeModel } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, openTestDatabase } from '@posts-auto/db/testing';
import { TRIAL_MAX_POSTS, confirmSignup, requestSignup } from '@posts-auto/services';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRequestTick } from './requests.ts';
import { type RunReport, runWeeklyGeneration } from './weekly.ts';

let db: Database;
let owner: string;
let workspaceId: string;
let account: string;
// Lundi 16 novembre 2026, 7h30 à Paris.
const RUN = new Date('2026-11-16T06:30:00Z');

const counted = async () =>
  (await asSystem(db, (trx) => trx.selectFrom('ai_usage').select('id').where('workspace_id', '=', workspaceId).where('kind', '=', 'text').where('counted_in_quota', '=', true).execute())).length;

beforeAll(async () => {
  db = await openTestDatabase();
  const request = await requestSignup(db, { email: 'essai@exemple.fr', fullName: 'Essai', orgName: 'Essai SARL', orgKind: 'entreprise' }, RUN);
  if (request.kind !== 'confirm') throw new Error(request.kind);
  const outcome = await confirmSignup(db, request.token, RUN);
  if (!outcome.ok) throw new Error('inscription');
  owner = outcome.session.userId;
  workspaceId = outcome.workspaceId;
  account = await createAccount(db, workspaceId, { display_name: 'Gérante', holder_user_id: owner });
  await asSystem(db, (trx) =>
    trx
      .insertInto('account_profiles')
      .values({
        account_id: account,
        workspace_id: workspaceId,
        posts_per_week: 3,
        usual_slots: JSON.stringify([
          { weekday: 2, time: '12:00' },
          { weekday: 3, time: '12:00' },
          { weekday: 4, time: '12:00' },
        ]),
      })
      .execute(),
  );
  // 8 posts déjà rédigés pendant l'essai : il en reste 2.
  await asSystem(db, (trx) =>
    trx
      .insertInto('ai_usage')
      .values(Array.from({ length: 8 }, () => ({ workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'write' as const, kind: 'text' as const, counted_in_quota: true })))
      .execute(),
  );
});
afterAll(() => closeTestDatabase(db));

describe('rédaction pendant l’essai gratuit (ONB-06)', () => {
  it('rédige les premiers créneaux jusqu’à la limite, signale les autres au rapport', async () => {
    const outcome = await runWeeklyGeneration({ db, model: new FakeModel(), clock: () => RUN }, workspaceId);
    expect(outcome.created).toBe(2);
    expect(await counted()).toBe(TRIAL_MAX_POSTS);
    const posts = await asSystem(db, (trx) => trx.selectFrom('posts').select('scheduled_at').where('workspace_id', '=', workspaceId).orderBy('scheduled_at').execute());
    // Les deux premiers créneaux de la semaine (mardi et mercredi).
    expect(posts.map((p) => p.scheduled_at.toISOString())).toEqual(['2026-11-17T11:00:00.000Z', '2026-11-18T11:00:00.000Z']);
    const run = await asSystem(db, (trx) => trx.selectFrom('generation_runs').select('report').where('id', '=', outcome.runId as string).executeTakeFirstOrThrow());
    const report = run.report as unknown as RunReport;
    const cut = report.unplaced.filter((u) => u.reason.includes('essai gratuit'));
    expect(cut).toHaveLength(4);
    expect(cut[0]).toMatchObject({ accountName: 'Gérante', reason: expect.stringMatching(/Limite de l’essai gratuit atteinte \(10 posts/) });
  });

  it('une demande de post ne peut plus aboutir une fois la limite atteinte', async () => {
    const request = await asSystem(db, async (trx) => {
      const row = await trx.insertInto('post_requests').values({ workspace_id: workspaceId, created_by: owner, raw_text: 'Post sur notre nouvel atelier' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('request_accounts').values({ request_id: row.id, account_id: account, workspace_id: workspaceId }).execute();
      return row.id;
    });
    const report = await runRequestTick({ db, model: new FakeModel(), clock: () => RUN });
    expect(report.impossible).toEqual([request]);
    const row = await asSystem(db, (trx) => trx.selectFrom('post_requests').select(['status', 'followup']).where('id', '=', request).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ status: 'impossible', followup: expect.stringMatching(/Gérante : Limite de l’essai gratuit atteinte/) });
  });
});

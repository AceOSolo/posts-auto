import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import { reportContent } from '../posts/content-reports.ts';
import { getPostDetail } from '../posts/post-queries.ts';
import { configureGeneration, generationStatus, getGenerationRun, requestGeneration } from './generation.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
const people = { admin: '', editor: '', contributor: '', viewer: '', stranger: '' };
const NOW = new Date('2026-11-16T09:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  const other = (await createOrganization(db)).workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.admin, 'admin');
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.contributor, 'contributor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  await addMember(db, other, people.stranger, 'admin');
  accountId = await createAccount(db, workspaceId, { display_name: 'JP' });
});
afterAll(() => closeTestDatabase(db));

describe('pilotage de la rédaction (GEN-01, GEN-11)', () => {
  it('droits : l’éditeur lance, l’administrateur programme, le lecteur consulte', async () => {
    expect(await generationStatus(db, people.editor, workspaceId, NOW)).toMatchObject({ canLaunch: true, canConfigure: false, autoGeneration: false, cron: '30 7 * * 1', running: false, runs: [] });
    expect(await generationStatus(db, people.admin, workspaceId, NOW)).toMatchObject({ canLaunch: true, canConfigure: true });
    expect(await generationStatus(db, people.viewer, workspaceId, NOW)).toMatchObject({ canLaunch: false, canConfigure: false });
    await expect(generationStatus(db, people.stranger, workspaceId, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('« Lancer la rédaction » note la demande pour la tâche de fond', async () => {
    await expect(requestGeneration(db, people.contributor, workspaceId, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await requestGeneration(db, people.editor, workspaceId, NOW);
    expect((await generationStatus(db, people.editor, workspaceId, NOW)).requestedAt).toEqual(NOW);
  });

  it('programmation contrôlée ; réservée à l’administration', async () => {
    await expect(configureGeneration(db, people.admin, workspaceId, { auto: true, cron: 'lundi 7h30' }, NOW)).rejects.toMatchObject({ code: 'cron_invalide' });
    await expect(configureGeneration(db, people.editor, workspaceId, { auto: true, cron: '0 8 * * 1' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await configureGeneration(db, people.admin, workspaceId, { auto: true, cron: ' 0  8 * * 1 ' }, NOW);
    expect(await generationStatus(db, people.viewer, workspaceId, NOW)).toMatchObject({ autoGeneration: true, cron: '0 8 * * 1' });
  });

  it('rapports résumés et coût du mois', async () => {
    const run = await asSystem(db, async (trx) => {
      const row = await trx
        .insertInto('generation_runs')
        .values({
          workspace_id: workspaceId,
          kind: 'weekly',
          status: 'done',
          started_at: NOW,
          finished_at: NOW,
          weeks: ['2026-11-16', '2026-11-23'],
          model: 'claude-opus-5-5',
          prompt_version: 'v1',
          report: JSON.stringify({ posts: [{ remaining: [] }, { remaining: ['Chiffre absent'] }], unplaced: [{}], errors: [], costUsd: 0.42 }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('ai_usage')
        .values([
          { workspace_id: workspaceId, run_id: row.id, provider: 'anthropic', model: 'claude-opus-5-5', purpose: 'write', kind: 'text', cost_usd: '0.30', cost_eur: '0.26', counted_in_quota: true, at: NOW },
          { workspace_id: workspaceId, run_id: row.id, provider: 'anthropic', model: 'claude-opus-5-5', purpose: 'verify', kind: 'text', cost_usd: '0.12', cost_eur: '0.10', counted_in_quota: false, at: NOW },
          // Mois précédent : pas compté.
          { workspace_id: workspaceId, provider: 'anthropic', model: 'claude-opus-5-5', purpose: 'write', kind: 'text', cost_usd: '9', cost_eur: '8', counted_in_quota: true, at: new Date('2026-10-30T09:00:00Z') },
        ])
        .execute();
      return row.id;
    });
    const status = await generationStatus(db, people.viewer, workspaceId, NOW);
    expect(status.runs[0]).toMatchObject({ id: run, status: 'done', created: 2, withMarkers: 1, unplaced: 1, errors: 0, costUsd: 0.42 });
    expect(status.month).toEqual({ costUsd: 0.42, costEur: 0.36, countedPosts: 1 });
    expect(await getGenerationRun(db, people.viewer, workspaceId, run)).toMatchObject({ weeks: ['2026-11-16', '2026-11-23'], model: 'claude-opus-5-5', promptVersion: 'v1' });
    await expect(getGenerationRun(db, people.stranger, workspaceId, run)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('transparence (GEN-06, GEN-12)', () => {
  it('le post affiche son origine, avec un lien vers sa source', async () => {
    const cell = await asSystem(db, (trx) =>
      trx.insertInto('planning_cells').values({ workspace_id: workspaceId, row_kind: 'account', account_id: accountId, week_start: '2026-11-16', content: 'Webinaire DUERP' }).returning('id').executeTakeFirstOrThrow(),
    );
    const fromCell = await createPost(db, workspaceId, accountId, { planning_cell_id: cell.id });
    expect((await getPostDetail(db, people.viewer, fromCell, NOW)).origin).toMatchObject({
      label: 'Planning',
      detail: 'Webinaire DUERP',
      href: `/planning/${workspaceId}/case?ligne=${encodeURIComponent(`compte:${accountId}`)}&semaine=2026-11-16`,
      aiWritten: true,
      versionNo: 1,
    });
    const idea = await asSystem(db, (trx) => trx.insertInto('ideas').values({ workspace_id: workspaceId, title: 'Nouvelle salle', origin: 'team' }).returning('id').executeTakeFirstOrThrow());
    const fromIdea = await createPost(db, workspaceId, accountId, { idea_id: idea.id, origin: 'team_idea', scheduled_at: new Date('2026-11-18T11:00:00Z') });
    expect((await getPostDetail(db, people.viewer, fromIdea, NOW)).origin).toMatchObject({ label: 'Idée de l’équipe', detail: 'Nouvelle salle' });
    const byAi = await createPost(db, workspaceId, accountId, { origin: 'ai_idea', source_note: 'La prévention des TMS', scheduled_at: new Date('2026-11-19T11:00:00Z') });
    expect((await getPostDetail(db, people.viewer, byAi, NOW)).origin).toMatchObject({ label: 'Idée de l’IA', detail: 'La prévention des TMS', href: null });
  });

  it('toute personne qui voit le post peut le signaler ; jamais celui d’un autre client', async () => {
    const postId = await createPost(db, workspaceId, accountId, { scheduled_at: new Date('2026-11-20T11:00:00Z') });
    const receipt = await reportContent(db, people.viewer, postId, ' Chiffre faux dans la 2e phrase ', NOW);
    expect(receipt).toMatchObject({ accountName: 'JP', reporterEmail: expect.stringContaining('viewer.') });
    const stored = await asSystem(db, (trx) => trx.selectFrom('content_reports').select(['reason', 'status']).where('id', '=', receipt.reportId).executeTakeFirstOrThrow());
    expect(stored).toEqual({ reason: 'Chiffre faux dans la 2e phrase', status: 'open' });
    await expect(reportContent(db, people.viewer, postId, '  ', NOW)).rejects.toMatchObject({ code: 'motif_signalement_requis' });
    await expect(reportContent(db, people.stranger, postId, 'x', NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

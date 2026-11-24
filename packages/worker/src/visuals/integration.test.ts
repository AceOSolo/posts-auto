/**
 * Visuels dans la chaîne de rédaction (REC-18) : rédaction hebdomadaire, reprise, demande,
 * et « refaire le visuel » (VIS-13).
 */
import { FakeModel, ModelError } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { FakeImageGenerator } from '@posts-auto/visuals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRequestTick } from '../generation/requests.ts';
import { runReworkTick } from '../generation/reworks.ts';
import { type RunReport, runWeeklyGeneration } from '../generation/weekly.ts';
import { MemoryMediaStore } from '../media/media-store.ts';
import { runVisualTick } from './visual-job.ts';

let db: Database;
let workspaceId: string;
let holder: string;
let jp: string;
const media = new MemoryMediaStore();
const images = new FakeImageGenerator();
// Lundi 16 novembre 2026, 7h30 à Paris.
const RUN = new Date('2026-11-16T06:30:00Z');
const LATER = new Date('2026-11-16T09:00:00Z');

const visualsOf = (postId: string) =>
  asSystem(db, (trx) =>
    trx
      .selectFrom('post_media as pm')
      .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
      .select(['pm.position', 'pm.alt_text', 'm.id', 'm.kind', 'm.ai_generated', 'm.source_asset_id', 'm.render_content'])
      .where('pm.post_id', '=', postId)
      .orderBy('pm.position')
      .execute(),
  );
const imageCount = async () =>
  (await asSystem(db, (trx) => trx.selectFrom('ai_usage').select('units').where('workspace_id', '=', workspaceId).where('kind', '=', 'image').execute())).reduce((n, r) => n + r.units, 0);
const photoOf = (content: unknown) => (content as { photo: string | null }).photo;

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  holder = await createUser(db, 'titulaire');
  await addMember(db, workspaceId, holder, 'contributor');
  jp = await createAccount(db, workspaceId, { display_name: 'Jean-Pierre', holder_user_id: holder });
  await asSystem(db, (trx) =>
    trx
      .insertInto('account_profiles')
      .values({
        account_id: jp,
        workspace_id: workspaceId,
        posts_per_week: 2,
        usual_slots: JSON.stringify([
          { weekday: 2, time: '12:00' },
          { weekday: 4, time: '12:00' },
        ]),
      })
      .execute(),
  );
});
afterAll(() => closeTestDatabase(db));

describe('visuels des posts rédigés (REC-18)', () => {
  it('rédaction hebdomadaire : chaque post a son visuel, un sur deux avec une image générée', async () => {
    const outcome = await runWeeklyGeneration({ db, model: new FakeModel(), clock: () => RUN, media, images }, workspaceId);
    expect(outcome).toMatchObject({ created: 4, errors: 0 });
    const posts = await asSystem(db, (trx) => trx.selectFrom('posts').select(['id', 'status']).where('account_id', '=', jp).orderBy('scheduled_at').execute());
    const visuals = await Promise.all(posts.map((p) => visualsOf(p.id)));
    expect(visuals.every((v) => v.length === 1 && v[0]?.kind === 'rendered' && v[0]?.position === 1)).toBe(true);
    expect(visuals.map((v) => photoOf(v[0]?.render_content))).toEqual(['generated', null, 'generated', null]);
    // VIS-12 : l'image générée est signalée dans le texte alternatif envoyé à LinkedIn.
    expect(visuals.map((v) => v[0]?.ai_generated)).toEqual([true, false, true, false]);
    expect(visuals[0]?.[0]?.alt_text).toMatch(/Illustration générée par IA\.$/);
    expect(await imageCount()).toBe(2);

    const run = await asSystem(db, (trx) => trx.selectFrom('generation_runs').select('report').where('id', '=', outcome.runId as string).executeTakeFirstOrThrow());
    const report = run.report as unknown as RunReport;
    expect(report.posts.map((p) => p.visual?.photo)).toEqual(expect.arrayContaining(['generated', null]));
    expect(report.posts.every((p) => p.visual?.made)).toBe(true);
  });

  it('reprise « à modifier » : le visuel reprend les nouveaux mots, avec la même photo et sans nouvelle image', async () => {
    const [first] = await asSystem(db, (trx) => trx.selectFrom('posts').select('id').where('account_id', '=', jp).orderBy('scheduled_at').limit(1).execute());
    const before = (await visualsOf(first?.id as string))[0];
    await asSystem(db, (trx) => trx.updateTable('posts').set({ status: 'modif', decision_note: 'Plus concret, svp.' }).where('id', '=', first?.id as string).execute());

    const report = await runReworkTick({ db, model: new FakeModel(), clock: () => LATER, media, images });
    expect(report.reworked).toEqual([first?.id]);
    const next = await asSystem(db, (trx) => trx.selectFrom('posts').select('id').where('replaces_post_id', '=', first?.id as string).executeTakeFirstOrThrow());
    const after = await visualsOf(next.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'rendered', position: 1, source_asset_id: before?.source_asset_id, ai_generated: true });
    expect(after[0]?.id).not.toBe(before?.id);
    expect(photoOf(after[0]?.render_content)).toBe('kept');
    expect(await imageCount()).toBe(2);
  });

  it('demande de post : visuel préparé sans photo fournie ; les photos fournies font le visuel', async () => {
    const newRequest = (photos: number) =>
      asSystem(db, async (trx) => {
        const request = await trx.insertInto('post_requests').values({ workspace_id: workspaceId, created_by: holder, raw_text: 'Post sur la nouvelle salle de formation' }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('request_accounts').values({ request_id: request.id, account_id: jp, workspace_id: workspaceId }).execute();
        for (let i = 0; i < photos; i += 1) {
          const asset = await trx.insertInto('media_assets').values({ workspace_id: workspaceId, kind: 'upload', storage_key: `test/${request.id}/${i}.gif`, mime: 'image/gif' }).returning('id').executeTakeFirstOrThrow();
          await trx.insertInto('request_photos').values({ request_id: request.id, asset_id: asset.id, workspace_id: workspaceId, position: i + 1 }).execute();
        }
        return request.id;
      });
    const without = await newRequest(0);
    const withPhotos = await newRequest(2);
    const report = await runRequestTick({ db, model: new FakeModel(), clock: () => LATER, media, images });
    expect([...report.done].sort()).toEqual([without, withPhotos].sort());
    const postOf = async (requestId: string) => (await asSystem(db, (trx) => trx.selectFrom('posts').select('id').where('request_id', '=', requestId).executeTakeFirstOrThrow())).id;
    expect((await visualsOf(await postOf(without))).map((v) => v.kind)).toEqual(['rendered']);
    expect((await visualsOf(await postOf(withPhotos))).map((v) => v.kind)).toEqual(['upload', 'upload']);
  });
});

describe('refaire le visuel (VIS-13)', () => {
  it('sans photo, avec une consigne : le nouveau visuel prend la place de l’ancien', async () => {
    const post = await asSystem(db, (trx) =>
      trx.selectFrom('posts').select('id').where('account_id', '=', jp).where('status', '=', 'a_valider').where('request_id', 'is', null).orderBy('scheduled_at').limit(1).executeTakeFirstOrThrow(),
    );
    const before = await visualsOf(post.id);
    await asSystem(db, (trx) => trx.insertInto('visual_tasks').values({ post_id: post.id, workspace_id: workspaceId, reason: 'redo', instruction: 'Un titre plus direct', photo_mode: 'none', requested_by: holder }).execute());
    const report = await runVisualTick({ db, model: new FakeModel(), media, images, clock: () => LATER });
    expect(report).toMatchObject({ done: [post.id], failed: [] });
    const after = await visualsOf(post.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before[0]?.id);
    expect(after[0]?.render_content).toMatchObject({ photo: null, instruction: 'Un titre plus direct' });
    expect(await asSystem(db, (trx) => trx.selectFrom('visual_tasks').select('post_id').where('post_id', '=', post.id).execute())).toEqual([]);
  });

  it('un nouveau visuel sur un post validé le renvoie en validation : personne ne l’a encore vu', async () => {
    const post = await createPost(db, workspaceId, jp, { status: 'valide', scheduled_at: new Date('2026-12-03T11:00:00Z'), week_start: '2026-11-30' });
    await asSystem(db, (trx) => trx.insertInto('visual_tasks').values({ post_id: post, workspace_id: workspaceId, reason: 'new', photo_mode: 'none', requested_by: holder }).execute());
    expect((await runVisualTick({ db, model: new FakeModel(), media, images, clock: () => LATER })).done).toEqual([post]);
    expect(await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', post).executeTakeFirstOrThrow())).toEqual({ status: 'a_valider' });
    const history = await asSystem(db, (trx) => trx.selectFrom('post_status_history').select(['from_status', 'to_status', 'actor_kind']).where('post_id', '=', post).where('to_status', '=', 'a_valider').where('from_status', '=', 'valide').execute());
    expect(history).toEqual([{ from_status: 'valide', to_status: 'a_valider', actor_kind: 'system' }]);
  });

  it('abandonne la tâche d’un post déjà publié', async () => {
    const published = await createPost(db, workspaceId, jp, {
      status: 'publie',
      scheduled_at: new Date('2026-11-10T11:00:00Z'),
      published_at: new Date('2026-11-10T11:00:05Z'),
      external_post_urn: 'urn:li:share:1',
      week_start: '2026-11-09',
    });
    await asSystem(db, (trx) => trx.insertInto('visual_tasks').values({ post_id: published, workspace_id: workspaceId, reason: 'redo' }).execute());
    const report = await runVisualTick({ db, model: new FakeModel(), media, images, clock: () => LATER });
    expect(report.dropped).toEqual([published]);
    expect(await visualsOf(published)).toEqual([]);
  });

  it('IA qui décline : tâche en échec, l’erreur est gardée pour l’afficher', async () => {
    const post = await createPost(db, workspaceId, jp, { scheduled_at: new Date('2026-12-01T11:00:00Z'), week_start: '2026-11-30' });
    await asSystem(db, (trx) => trx.insertInto('visual_tasks').values({ post_id: post, workspace_id: workspaceId, reason: 'redo', photo_mode: 'new' }).execute());
    const model = new FakeModel(() => {
      throw new ModelError('refused', 'Demande déclinée');
    });
    const report = await runVisualTick({ db, model, media, images, clock: () => LATER });
    expect(report.failed).toEqual([post]);
    const task = await asSystem(db, (trx) => trx.selectFrom('visual_tasks').select(['failed_at', 'error', 'lease_until']).where('post_id', '=', post).executeTakeFirstOrThrow());
    expect(task).toMatchObject({ error: 'Demande déclinée', lease_until: null });
    expect(task.failed_at).not.toBeNull();
    // Une tâche en échec n'est plus reprise.
    expect((await runVisualTick({ db, model: new FakeModel(), media, images, clock: () => LATER })).done).toEqual([]);
  });

  it('IA indisponible : nouvel essai plus tard', async () => {
    const post = await createPost(db, workspaceId, jp, { scheduled_at: new Date('2026-12-02T11:00:00Z'), week_start: '2026-11-30' });
    await asSystem(db, (trx) => trx.insertInto('visual_tasks').values({ post_id: post, workspace_id: workspaceId, reason: 'redo' }).execute());
    const failing = new FakeModel(() => {
      throw new ModelError('unavailable', 'surcharge');
    });
    expect((await runVisualTick({ db, model: failing, media, images, clock: () => LATER })).retrying).toEqual([post]);
    expect((await runVisualTick({ db, model: new FakeModel(), media, images, clock: () => LATER })).done).toEqual([post]);
    expect((await visualsOf(post)).map((v) => v.kind)).toEqual(['rendered']);
  });
});

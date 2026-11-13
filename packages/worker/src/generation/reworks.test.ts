import { FakeModel, ModelError } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REWORK_MAX_ATTEMPTS, runReworkTick } from './reworks.ts';

let db: Database;
let workspaceId: string;
let holder: string;
let editor: string;
let jp: string;
// Lundi 16 novembre 2026, 10h00 à Paris.
const NOW = new Date('2026-11-16T09:00:00Z');
const paris = (local: string) => new Date(`${local}+01:00`);

async function decided(status: 'modif' | 'refuse', note: string | null, values: Parameters<typeof createPost>[3] = {}): Promise<string> {
  const id = await createPost(db, workspaceId, jp, { body: 'Texte d’origine rédigé par l’IA.', source_note: 'Sujet d’origine', ...values });
  await asSystem(db, (trx) => trx.updateTable('posts').set({ status, decision_note: note, decided_by: holder, decided_at: NOW }).where('id', '=', id).execute());
  return id;
}

const post = (id: string) => asSystem(db, (trx) => trx.selectFrom('posts').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
const successor = (id: string) =>
  asSystem(db, (trx) =>
    trx.selectFrom('posts as p').innerJoin('post_versions as v', 'v.id', 'p.current_version_id').select(['p.id', 'p.status', 'p.version_no', 'p.origin', 'p.scheduled_at', 'p.idea_id', 'p.planning_cell_id', 'v.body']).where('p.replaces_post_id', '=', id).executeTakeFirst(),
  );

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  holder = await createUser(db, 'titulaire');
  editor = await createUser(db, 'editrice');
  await addMember(db, workspaceId, holder, 'contributor');
  await addMember(db, workspaceId, editor, 'editor');
  jp = await createAccount(db, workspaceId, { display_name: 'Jean-Pierre', holder_user_id: holder });
  await asSystem(db, (trx) => trx.insertInto('account_profiles').values({ account_id: jp, workspace_id: workspaceId, posts_per_week: 1, usual_slots: JSON.stringify([{ weekday: 2, time: '12:00' }]) }).execute());
});
afterAll(() => closeTestDatabase(db));

describe('reprise « à modifier » (GEN-07, RÈG-12)', () => {
  it('nouvelle version qui applique la note en repartant du texte, même créneau, photos conservées ; le titulaire est prévenu', async () => {
    const id = await decided('modif', 'Plus court, et citer la date du webinaire', { scheduled_at: paris('2026-11-17T12:00') });
    await asSystem(db, async (trx) => {
      const asset = await trx.insertInto('media_assets').values({ workspace_id: workspaceId, kind: 'upload', storage_key: `test/${id}/1.gif`, mime: 'image/gif' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: id, asset_id: asset.id, position: 1 }).execute();
    });
    const model = new FakeModel();
    const report = await runReworkTick({ db, model, clock: () => NOW });
    expect(report.reworked).toEqual([id]);

    const next = await successor(id);
    expect(next).toMatchObject({ status: 'a_valider', version_no: 2, origin: 'planning', scheduled_at: paris('2026-11-17T12:00') });
    expect(await post(id)).toMatchObject({ status: 'remplace', decision_note: 'Plus court, et citer la date du webinaire' });
    expect(model.calls[0]?.purpose).toBe('rework');
    expect(model.calls[0]?.task).toContain('Texte d’origine rédigé par l’IA.');
    expect(model.calls[0]?.task).toContain('Plus court, et citer la date du webinaire');
    const media = await asSystem(db, (trx) => trx.selectFrom('post_media').select('position').where('post_id', '=', next?.id as string).execute());
    expect(media).toHaveLength(1);
    const notes = await asSystem(db, (trx) => trx.selectFrom('notifications').select(['user_id', 'kind', 'channel']).where('kind', '=', 'nouvelle_version').execute());
    expect(notes).toEqual(expect.arrayContaining([{ user_id: holder, kind: 'nouvelle_version', channel: 'email' }]));
    // Une reprise ne compte pas dans le quota (RÈG-19).
    const usage = await asSystem(db, (trx) => trx.selectFrom('ai_usage').select('counted_in_quota').where('post_id', '=', next?.id as string).execute());
    expect(usage.every((u) => !u.counted_in_quota)).toBe(true);
  });

  it('créneau à moins de 3 heures : la reprise prend le prochain créneau libre à partir de maintenant + 3 h (RÈG-14)', async () => {
    const id = await decided('modif', 'Changer l’accroche', { scheduled_at: paris('2026-11-16T11:00') });
    await runReworkTick({ db, model: new FakeModel(), clock: () => NOW });
    expect((await successor(id))?.scheduled_at).toEqual(paris('2026-11-16T13:00'));
  });

  it('sans note, la reprise attend (RÈG-23)', async () => {
    const id = await decided('modif', null, { scheduled_at: paris('2026-11-19T12:00') });
    expect((await runReworkTick({ db, model: new FakeModel(), clock: () => NOW })).waiting).toContain(id);
    expect(await post(id)).toMatchObject({ status: 'modif', rework_lease_until: null });
  });
});

describe('reprise après refus (RÈG-13, REC-10)', () => {
  it('le créneau est réattribué à un sujet de la réserve, le commentaire est conservé, le sujet refusé mis de côté', async () => {
    const cell = await asSystem(db, (trx) =>
      trx.insertInto('planning_cells').values({ workspace_id: workspaceId, row_kind: 'account', account_id: jp, week_start: '2026-11-23', content: 'Sujet refusé' }).returning('id').executeTakeFirstOrThrow(),
    );
    const reserve = await asSystem(db, async (trx) => {
      const idea = await trx.insertInto('ideas').values({ workspace_id: workspaceId, title: 'Sujet de réserve', origin: 'ai_reserve' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('idea_accounts').values({ idea_id: idea.id, account_id: jp, workspace_id: workspaceId }).execute();
      return idea.id;
    });
    const id = await decided('refuse', 'deja_traite : déjà publié en octobre', { scheduled_at: paris('2026-11-24T12:00'), week_start: '2026-11-23', planning_cell_id: cell.id });
    const model = new FakeModel();
    await runReworkTick({ db, model, clock: () => NOW });

    const next = await successor(id);
    expect(next).toMatchObject({ status: 'a_valider', version_no: 2, origin: 'ai_reserve', idea_id: reserve, planning_cell_id: null, scheduled_at: paris('2026-11-24T12:00') });
    expect(model.calls[0]?.task).toContain('Motif : Sujet déjà traité récemment (déjà publié en octobre)');
    expect(await post(id)).toMatchObject({ status: 'remplace', decision_note: 'deja_traite : déjà publié en octobre' });
    const history = await asSystem(db, (trx) => trx.selectFrom('post_status_history').select(['from_status', 'to_status']).where('post_id', '=', id).execute());
    expect(history).toEqual(expect.arrayContaining([{ from_status: 'refuse', to_status: 'remplace' }]));
    const cellAfter = await asSystem(db, (trx) => trx.selectFrom('planning_cells').select('set_aside_reason').where('id', '=', cell.id).executeTakeFirstOrThrow());
    expect(cellAfter.set_aside_reason).toContain('Sujet déjà traité récemment');
    const idea = await asSystem(db, (trx) => trx.selectFrom('ideas').select('status').where('id', '=', reserve).executeTakeFirstOrThrow());
    expect(idea.status).toBe('used');
  });

  it('sans autre matière, l’IA choisit un sujet en évitant celui qui a été refusé', async () => {
    const id = await decided('refuse', 'sujet_non_pertinent', { scheduled_at: paris('2026-11-26T12:00'), week_start: '2026-11-23', source_note: 'Les vœux de fin d’année' });
    const model = new FakeModel();
    await runReworkTick({ db, model, clock: () => NOW });
    expect(await successor(id)).toMatchObject({ origin: 'ai_idea', version_no: 2 });
    expect(model.calls[0]?.task).toContain('Sujet refusé, à ne pas reprendre : « Les vœux de fin d’année »');
  });
});

describe('limites', () => {
  it('au-delà de 3 reprises, le post sort du circuit et l’équipe est prévenue', async () => {
    const id = await decided('refuse', 'ton_inadapte', { scheduled_at: paris('2026-11-27T12:00'), week_start: '2026-11-23', version_no: 4 });
    expect((await runReworkTick({ db, model: new FakeModel(), clock: () => NOW })).abandoned).toContain(id);
    expect((await post(id)).status).toBe('abandonne');
    const notes = await asSystem(db, (trx) => trx.selectFrom('notifications').select('user_id').where('kind', '=', 'reprise_manuelle').execute());
    expect(notes.map((n) => n.user_id)).toContain(editor);
  });

  it('fournisseur indisponible : nouvel essai aux passes suivantes, puis l’équipe prend la main', async () => {
    const id = await decided('modif', 'Ajouter un exemple', { scheduled_at: paris('2026-11-20T12:00') });
    const down = new FakeModel(() => {
      throw new ModelError('unavailable', 'Fournisseur injoignable');
    });
    for (let attempt = 1; attempt <= REWORK_MAX_ATTEMPTS; attempt += 1) {
      expect((await runReworkTick({ db, model: down, clock: () => NOW })).retrying).toContain(id);
    }
    expect(await post(id)).toMatchObject({ status: 'modif', rework_attempts: REWORK_MAX_ATTEMPTS, last_error: 'Fournisseur injoignable' });
    expect((await runReworkTick({ db, model: new FakeModel(), clock: () => NOW })).reworked).not.toContain(id);
  });
});

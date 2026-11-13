import { FakeModel, ModelError } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUEST_MAX_ATTEMPTS, runRequestTick } from './requests.ts';

let db: Database;
let workspaceId: string;
let requester: string;
let holder: string;
let jp: string;
let page: string;
// Lundi 16 novembre 2026, 10h00 à Paris.
const NOW = new Date('2026-11-16T09:00:00Z');
const paris = (local: string) => new Date(`${local}+01:00`);

async function newRequest(values: { accountIds: string[]; wishedAt?: Date | null; rawText?: string; photos?: number }): Promise<string> {
  return asSystem(db, async (trx) => {
    const request = await trx
      .insertInto('post_requests')
      .values({ workspace_id: workspaceId, created_by: requester, raw_text: values.rawText ?? 'Post sur la nouvelle salle de formation', links: ['https://secutop.fr/salle'], wished_at: values.wishedAt ?? null })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('request_accounts').values(values.accountIds.map((accountId) => ({ request_id: request.id, account_id: accountId, workspace_id: workspaceId }))).execute();
    for (let i = 0; i < (values.photos ?? 0); i += 1) {
      const asset = await trx.insertInto('media_assets').values({ workspace_id: workspaceId, kind: 'upload', storage_key: `test/${request.id}/${i}.gif`, mime: 'image/gif' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('request_photos').values({ request_id: request.id, asset_id: asset.id, workspace_id: workspaceId, position: i + 1 }).execute();
    }
    return request.id;
  });
}

const requestRow = (id: string) => asSystem(db, (trx) => trx.selectFrom('post_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
const postsOf = (id: string) =>
  asSystem(db, (trx) => trx.selectFrom('posts').select(['id', 'account_id', 'scheduled_at', 'origin', 'status', 'request_id']).where('request_id', '=', id).orderBy('scheduled_at').execute());

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  requester = await createUser(db, 'demandeuse');
  holder = await createUser(db, 'titulaire');
  await addMember(db, workspaceId, requester, 'contributor');
  await addMember(db, workspaceId, holder, 'contributor');
  jp = await createAccount(db, workspaceId, { display_name: 'Jean-Pierre', holder_user_id: holder });
  page = await createAccount(db, workspaceId, { display_name: 'Secutop', kind: 'page' });
});
afterAll(() => closeTestDatabase(db));

describe('demandes de post traitées dans l’heure (IDE-06)', () => {
  it('un post par compte, au créneau souhaité s’il est libre, sinon au prochain ; photos dans l’ordre ; suivi', async () => {
    const wished = paris('2026-11-18T12:00');
    // La page a déjà ses 2 posts du mercredi (PUB-06) : le créneau souhaité n'est libre que pour JP.
    await createPost(db, workspaceId, page, { scheduled_at: paris('2026-11-18T09:00'), week_start: '2026-11-16' });
    await createPost(db, workspaceId, page, { scheduled_at: paris('2026-11-18T16:00'), week_start: '2026-11-16' });
    const id = await newRequest({ accountIds: [jp, page], wishedAt: wished, photos: 2 });

    const report = await runRequestTick({ db, model: new FakeModel(), clock: () => NOW });
    expect(report.done).toEqual([id]);
    const created = await postsOf(id);
    expect(created.map((p) => [p.account_id, p.origin, p.status])).toEqual([
      [jp, 'request', 'a_valider'],
      [page, 'request', 'a_valider'],
    ]);
    expect(created[0]?.scheduled_at).toEqual(wished);
    // Page : premier créneau libre après celui souhaité, le lendemain à l'ouverture de la plage.
    expect(created[1]?.scheduled_at).toEqual(paris('2026-11-19T08:00'));

    const media = await asSystem(db, (trx) => trx.selectFrom('post_media').select(['post_id', 'position']).where('post_id', 'in', created.map((p) => p.id)).orderBy('post_id').orderBy('position').execute());
    expect(media).toHaveLength(4);
    const row = await requestRow(id);
    expect(row).toMatchObject({ status: 'done', lease_until: null });
    expect(row.followup).toContain('Post rédigé pour Jean-Pierre');
    expect(row.followup).toContain('le créneau souhaité était pris');

    const notes = await asSystem(db, (trx) => trx.selectFrom('notifications').select(['user_id', 'kind']).where('workspace_id', '=', workspaceId).execute());
    expect(notes).toEqual(expect.arrayContaining([{ user_id: requester, kind: 'demande_traitee' }, { user_id: holder, kind: 'posts_prets' }]));
    const usage = await asSystem(db, (trx) => trx.selectFrom('ai_usage').select('counted_in_quota').where('post_id', 'in', created.map((p) => p.id)).execute());
    expect(usage.filter((u) => u.counted_in_quota)).toHaveLength(2);
  });

  it('sans date souhaitée : le prochain créneau libre à au moins une heure ; une demande traitée ne l’est qu’une fois', async () => {
    const id = await newRequest({ accountIds: [jp] });
    await runRequestTick({ db, model: new FakeModel(), clock: () => NOW });
    const created = await postsOf(id);
    expect(created).toHaveLength(1);
    expect(created[0]?.scheduled_at.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 3_600_000);
    expect((await runRequestTick({ db, model: new FakeModel(), clock: () => NOW })).done).not.toContain(id);
  });

  it('fournisseur indisponible : nouvel essai, puis « impossible » au 3e échec, avec suivi', async () => {
    const id = await newRequest({ accountIds: [jp], rawText: 'Demande qui échouera' });
    const down = new FakeModel(() => {
      throw new ModelError('unavailable', 'Fournisseur injoignable');
    });
    for (let attempt = 1; attempt < REQUEST_MAX_ATTEMPTS; attempt += 1) {
      expect((await runRequestTick({ db, model: down, clock: () => NOW })).retrying).toEqual([id]);
      expect(await requestRow(id)).toMatchObject({ status: 'new', attempts: attempt, last_error: 'Fournisseur injoignable' });
    }
    expect((await runRequestTick({ db, model: down, clock: () => NOW })).impossible).toEqual([id]);
    expect((await requestRow(id)).followup).toContain('L’équipe de rédaction peut reprendre la demande');
  });

  it('une demande en cours n’est pas reprise par une autre passe tant que son bail court', async () => {
    const id = await newRequest({ accountIds: [jp], rawText: 'Demande en cours' });
    await asSystem(db, (trx) => trx.updateTable('post_requests').set({ status: 'in_progress', lease_until: new Date(NOW.getTime() + 60_000) }).where('id', '=', id).execute());
    expect((await runRequestTick({ db, model: new FakeModel(), clock: () => NOW })).done).not.toContain(id);
    expect((await runRequestTick({ db, model: new FakeModel(), clock: () => new Date(NOW.getTime() + 120_000) })).done).toContain(id);
  });

  it('aucun compte connecté : impossible, et le demandeur le sait', async () => {
    const paused = await createAccount(db, workspaceId, { display_name: 'En pause', status: 'paused' });
    const id = await newRequest({ accountIds: [paused] });
    expect((await runRequestTick({ db, model: new FakeModel(), clock: () => NOW })).impossible).toContain(id);
    expect((await requestRow(id)).followup).toContain('Aucun des comptes choisis n’est connecté');
  });
});

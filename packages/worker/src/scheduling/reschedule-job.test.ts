import { type Database, asSystem, createDatabase } from '@posts-auto/db';
import { createAccount, createOrganization, createPost, createUser } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { describeSlot, runRescheduleTick } from './reschedule-job.js';

let db: Database;
beforeAll(() => {
  db = createDatabase(inject('databaseUrl'), { maxConnections: 4 });
});
afterAll(async () => {
  await db.destroy();
});

// Mardi 17 novembre 2026, 12h00 à Paris = 11:00 UTC.
const NOON = new Date('2026-11-17T11:00:00Z');
const minutes = (n: number) => new Date(NOON.getTime() + n * 60_000);

async function scene() {
  const org = await createOrganization(db);
  const workspaceId = org.workspaceIds[0] as string;
  const holderId = await createUser(db, 'titulaire');
  const accountId = await createAccount(db, workspaceId, { holder_user_id: holderId });
  return { workspaceId, accountId, holderId };
}

const row = (id: string) => asSystem(db, (trx) => trx.selectFrom('posts').selectAll().where('id', '=', id).executeTakeFirstOrThrow());

describe('replanification des posts non validés (RÈG-08 à RÈG-11)', () => {
  it('laisse une heure au titulaire avant de décaler (REC-06)', async () => {
    const s = await scene();
    const postId = await createPost(db, s.workspaceId, s.accountId, { scheduled_at: NOON });
    const report = await runRescheduleTick({ db, clock: () => minutes(45) });
    expect(report.moved).not.toContain(postId);
    expect((await row(postId)).scheduled_at.toISOString()).toBe(NOON.toISOString());
  });

  it('décale au lendemain même heure, compte la replanification et prévient le titulaire (REC-07)', async () => {
    const s = await scene();
    const postId = await createPost(db, s.workspaceId, s.accountId, { scheduled_at: NOON });
    const report = await runRescheduleTick({ db, clock: () => minutes(61) });
    expect(report.moved).toContain(postId);

    const post = await row(postId);
    expect(post).toMatchObject({ status: 'a_valider', reschedule_count: 1, week_start: '2026-11-16' });
    expect(post.scheduled_at.toISOString()).toBe('2026-11-18T11:00:00.000Z'); // mercredi 12h00
    expect(post.original_scheduled_at?.toISOString()).toBe(NOON.toISOString());

    const history = await asSystem(db, (trx) =>
      trx.selectFrom('post_status_history').select('reason').where('post_id', '=', postId).executeTakeFirstOrThrow(),
    );
    expect(history.reason).toBe('Replanifié faute de validation : mardi 17 novembre à 12:00 → mercredi 18 novembre à 12:00 (RÈG-08)');

    const notification = await asSystem(db, (trx) =>
      trx.selectFrom('notifications').select(['user_id', 'kind', 'payload']).where('user_id', '=', s.holderId).executeTakeFirstOrThrow(),
    );
    expect(notification).toMatchObject({ kind: 'post_replanifie', payload: { postId, movedToAnotherWeek: false } });
  });

  it('passe un post du vendredi au lundi suivant en mettant à jour sa semaine', async () => {
    const s = await scene();
    const friday = new Date('2026-11-20T11:00:00Z');
    const postId = await createPost(db, s.workspaceId, s.accountId, { scheduled_at: friday });
    await runRescheduleTick({ db, clock: () => new Date('2026-11-20T12:30:00Z') });
    const post = await row(postId);
    expect(post.scheduled_at.toISOString()).toBe('2026-11-23T11:00:00.000Z');
    expect(post.week_start).toBe('2026-11-23');
  });

  it('abandonne au-delà de 5 replanifications et prévient le titulaire (RÈG-10)', async () => {
    const s = await scene();
    const postId = await createPost(db, s.workspaceId, s.accountId, { scheduled_at: NOON, reschedule_count: 5 });
    const report = await runRescheduleTick({ db, clock: () => minutes(61) });
    expect(report.abandoned).toContain(postId);
    expect((await row(postId)).status).toBe('abandonne');
  });

  it('ne touche ni les posts validés, ni ceux dont le créneau n’est pas passé', async () => {
    const s = await scene();
    const validated = await createPost(db, s.workspaceId, s.accountId, { scheduled_at: NOON, status: 'valide' });
    const future = await createPost(db, s.workspaceId, s.accountId, { scheduled_at: minutes(24 * 60) });
    const report = await runRescheduleTick({ db, clock: () => minutes(61) });
    expect(report.moved).not.toContain(validated);
    expect(report.moved).not.toContain(future);
  });

  it('formate un créneau en français dans le fuseau de l’espace', () => {
    expect(describeSlot(new Date('2026-10-20T10:00:00Z'), 'Europe/Paris')).toBe('mardi 20 octobre à 12:00');
  });
});

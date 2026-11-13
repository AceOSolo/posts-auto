import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors.ts';
import { weekDocument } from './week-document.ts';

let db: Database;
let workspaceId: string;
let viewer: string;
let stranger: string;
let jp: string;
const NOW = new Date('2026-11-16T09:00:00Z');
const W47 = '2026-11-16';

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  viewer = await createUser(db, 'lecteur');
  stranger = await createUser(db, 'autre');
  await addMember(db, workspaceId, viewer, 'viewer');
  await addMember(db, (await createOrganization(db)).workspaceIds[0] as string, stranger, 'admin');
  jp = await createAccount(db, workspaceId, { display_name: 'Jean-Pierre' });
});
afterAll(() => closeTestDatabase(db));

async function decided(at: string, status: 'publie' | 'valide', options: { edited?: boolean; changesRequested?: boolean; rescheduled?: boolean; hours?: number } = {}) {
  const scheduledAt = new Date(at);
  const createdAt = new Date(scheduledAt.getTime() - 48 * 3_600_000);
  const id = await createPost(db, workspaceId, jp, {
    scheduled_at: scheduledAt,
    week_start: W47,
    status,
    created_at: createdAt,
    decided_at: new Date(createdAt.getTime() + (options.hours ?? 4) * 3_600_000),
    reschedule_count: options.rescheduled ? 1 : 0,
    ...(status === 'publie' && { published_at: scheduledAt, external_post_urn: 'urn:li:share:1' }),
  });
  await asSystem(db, async (trx) => {
    if (options.edited) await trx.insertInto('post_versions').values({ workspace_id: workspaceId, post_id: id, revision: 2, body: 'Corrigé', author_kind: 'user' }).execute();
    if (options.changesRequested) {
      await trx.insertInto('post_status_history').values({ workspace_id: workspaceId, post_id: id, from_status: 'a_valider', to_status: 'modif', actor_kind: 'user', reason: 'Plus court', at: NOW }).execute();
    }
  });
}

describe('document de semaine (GEN-10)', () => {
  it('posts de la semaine et suivi par compte : validés tels quels, modifiés, refusés, délai, créneaux tenus', async () => {
    await decided('2026-11-17T11:00:00Z', 'publie', { hours: 2 });
    await decided('2026-11-18T11:00:00Z', 'publie', { edited: true, rescheduled: true, hours: 6 });
    await decided('2026-11-19T11:00:00Z', 'valide', { changesRequested: true, hours: 10 });
    const refusedId = await createPost(db, workspaceId, jp, { scheduled_at: new Date('2026-11-20T11:00:00Z'), week_start: W47, status: 'remplace' });
    await asSystem(db, (trx) =>
      trx.insertInto('post_status_history').values({ workspace_id: workspaceId, post_id: refusedId, from_status: 'a_valider', to_status: 'refuse', actor_kind: 'user', reason: 'deja_traite', at: NOW }).execute(),
    );

    const doc = await weekDocument(db, viewer, workspaceId, undefined, NOW);
    expect(doc).toMatchObject({ weekStart: W47, isoWeek: 47 });
    expect(doc.posts).toHaveLength(3);
    const week = doc.tracking.find((t) => t.accountName === 'Jean-Pierre')?.weeks.at(-1);
    expect(week).toEqual({ weekStart: W47, isoWeek: 47, proposed: 3, published: 2, validatedAsIs: 1, validatedModified: 2, refused: 1, medianDecisionHours: 6, onTime: 1 });
    expect(doc.tracking[0]?.weeks).toHaveLength(8);
    expect(doc.tracking[0]?.weeks[0]?.weekStart).toBe('2026-09-28');
  });

  it('semaine choisie, et rien pour une personne d’un autre client', async () => {
    expect((await weekDocument(db, viewer, workspaceId, '2026-11-09', NOW)).posts).toEqual([]);
    expect((await weekDocument(db, viewer, workspaceId, '2026-11-10', NOW)).weekStart).toBe(W47);
    await expect(weekDocument(db, stranger, workspaceId, undefined, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

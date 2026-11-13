import { FakeModel } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createOrganization, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { materializeRecurringEvents } from './recurring-events.ts';
import { runWeeklyGeneration } from './weekly.ts';

let db: Database;
// Lundi 16 novembre 2026, 7h30 à Paris.
const NOW = new Date('2026-11-16T06:30:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
});
afterAll(() => closeTestDatabase(db));

async function setup(recurrence: 'monthly' | 'yearly', startsOn: string) {
  const workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  const accountId = await createAccount(db, workspaceId, { display_name: 'Page' });
  const eventId = await asSystem(db, async (trx) => {
    await trx.insertInto('account_profiles').values({ account_id: accountId, workspace_id: workspaceId, posts_per_week: 1 }).execute();
    const event = await trx
      .insertInto('events')
      .values({ workspace_id: workspaceId, title: 'Webinaire mensuel', starts_on: startsOn, ends_on: null, link: 'https://exemple.fr/webinaire', recurrence })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('event_accounts').values({ event_id: event.id, account_id: accountId, workspace_id: workspaceId }).execute();
    return event.id;
  });
  return { workspaceId, accountId, eventId };
}

describe('rendez-vous récurrents (EDI-08)', () => {
  it('les occurrences des 60 prochains jours sont créées une fois, avec les comptes du modèle', async () => {
    const { workspaceId, accountId, eventId } = await setup('monthly', '2026-10-28');
    expect(await materializeRecurringEvents(db, NOW, workspaceId)).toBe(2);
    expect(await materializeRecurringEvents(db, NOW, workspaceId)).toBe(0);
    const occurrences = await asSystem(db, (trx) =>
      trx.selectFrom('events as e').innerJoin('event_accounts as a', 'a.event_id', 'e.id').select(['e.starts_on', 'e.recurrence', 'a.account_id']).where('e.series_id', '=', eventId).orderBy('e.starts_on').execute(),
    );
    expect(occurrences).toEqual([
      { starts_on: '2026-11-28', recurrence: 'none', account_id: accountId },
      { starts_on: '2026-12-28', recurrence: 'none', account_id: accountId },
    ]);
  });

  it('la rédaction relaie l’occurrence à venir comme un événement', async () => {
    const { workspaceId, eventId } = await setup('monthly', '2026-10-28');
    await runWeeklyGeneration({ db, model: new FakeModel(), clock: () => NOW }, workspaceId);
    const relay = await asSystem(db, (trx) =>
      trx
        .selectFrom('posts as p')
        .innerJoin('events as e', 'e.id', 'p.event_id')
        .select(['p.origin', 'e.starts_on', 'e.series_id', 'p.must_publish_by'])
        .where('p.workspace_id', '=', workspaceId)
        .executeTakeFirstOrThrow(),
    );
    expect(relay).toMatchObject({ origin: 'event', starts_on: '2026-11-28', series_id: eventId });
    expect(relay.must_publish_by).toEqual(new Date('2026-11-27T23:00:00Z'));
  });
});

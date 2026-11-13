import { FakeModel } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { INTERPRET_MAX_PER_HOUR, interpretPostRequest } from './interpret.ts';

let db: Database;
let workspaceId: string;
let jp: string;
let contributor: string;
let viewer: string;
const NOW = new Date('2026-11-13T14:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  contributor = await createUser(db, 'contributrice');
  viewer = await createUser(db, 'lecteur');
  await addMember(db, workspaceId, contributor, 'contributor');
  await addMember(db, workspaceId, viewer, 'viewer');
  jp = await createAccount(db, workspaceId, { display_name: 'Jean-Pierre' });
});
afterAll(() => closeTestDatabase(db));

describe('pré-remplissage d’une demande par l’IA (IDE-04)', () => {
  it('donne à l’IA les comptes de l’espace et la date du jour à l’heure de l’espace ; enregistre le coût hors quota', async () => {
    const model = new FakeModel(() => ({
      accountIds: [jp],
      title: 'Nouvelle salle',
      details: 'Salle de 40 m² à Lyon',
      links: [],
      wishedDate: '2026-11-17',
      wishedTime: '12:00',
      toSpecify: ['Date d’ouverture'],
      ignoredInstructions: [],
    }));
    const result = await interpretPostRequest(db, model, contributor, workspaceId, 'Un post pour JP mardi midi sur la salle de Lyon', NOW);
    expect(result).toMatchObject({ accountIds: [jp], wishedDate: '2026-11-17', wishedTime: '12:00', toSpecify: ['Date d’ouverture'] });
    expect(model.calls[0]?.context).toContain(`- ${jp} : Jean-Pierre`);
    expect(model.calls[0]?.context).toContain('vendredi 13 novembre 2026 (2026-11-13)');
    const usage = await asSystem(db, (trx) => trx.selectFrom('ai_usage').select(['purpose', 'counted_in_quota']).where('workspace_id', '=', workspaceId).execute());
    expect(usage).toEqual([{ purpose: 'interpret', counted_in_quota: false }]);
  });

  it('refusé aux lecteurs, et limité à 20 par heure', async () => {
    await expect(interpretPostRequest(db, new FakeModel(), viewer, workspaceId, 'x', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(interpretPostRequest(db, new FakeModel(), contributor, workspaceId, '  ', NOW)).rejects.toMatchObject({ code: 'demande_vide' });
    for (let i = 1; i < INTERPRET_MAX_PER_HOUR; i += 1) await interpretPostRequest(db, new FakeModel(), contributor, workspaceId, 'Une demande', NOW);
    await expect(interpretPostRequest(db, new FakeModel(), contributor, workspaceId, 'Une demande de trop', NOW)).rejects.toMatchObject({ code: 'trop_de_preremplissages' });
    // Une heure plus tard, c'est de nouveau possible.
    await expect(interpretPostRequest(db, new FakeModel(), contributor, workspaceId, 'Une demande', new Date(NOW.getTime() + 3_601_000))).resolves.toBeDefined();
  });
});

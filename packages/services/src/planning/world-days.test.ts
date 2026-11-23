import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import { listEvents } from './subjects-events.ts';
import { addWorldDay, worldDaySuggestions } from './world-days.ts';

let db: Database;
let workspaceId: string;
let noPageWorkspace: string;
let page: string;
let profile: string;
let paused: string;
let soloA: string;
let soloB: string;
const people = { editor: '', viewer: '', stranger: '' };
// Lundi 23 novembre 2026, 10 h à Paris.
const NOW = new Date('2026-11-23T09:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  noPageWorkspace = (await createOrganization(db)).workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  await addMember(db, noPageWorkspace, people.editor, 'editor');
  profile = await createAccount(db, workspaceId, { display_name: 'Titulaire' });
  page = await createAccount(db, workspaceId, { display_name: 'Page', kind: 'page' });
  paused = await createAccount(db, workspaceId, { display_name: 'Page en pause', kind: 'page', status: 'paused' });
  soloA = await createAccount(db, noPageWorkspace, { display_name: 'Profil A' });
  soloB = await createAccount(db, noPageWorkspace, { display_name: 'Profil B' });
  await asSystem(db, (trx) => trx.updateTable('workspaces').set({ sector: 'Santé' }).where('id', 'in', [workspaceId, noPageWorkspace]).execute());
});
afterAll(() => closeTestDatabase(db));

describe('journées suggérées (PLA-10)', () => {
  it('suggère selon le secteur de l’espace', async () => {
    const { suggestions, canEdit } = await worldDaySuggestions(db, people.editor, workspaceId, NOW);
    expect(canEdit).toBe(true);
    expect(suggestions[0]).toMatchObject({ id: 'sida', date: '2026-12-01', matchesSector: true });
  });

  it('ajoute en un clic un événement annuel relayé par les pages actives', async () => {
    const id = await addWorldDay(db, people.editor, workspaceId, 'sida', NOW);
    const { events } = await listEvents(db, people.editor, workspaceId, '2026-11-23');
    const event = events.find((e) => e.id === id);
    expect(event).toMatchObject({ startsOn: '2026-12-01', recurrence: 'yearly', link: 'https://www.who.int/campaigns' });
    expect(event?.details).toContain('vérification');
    expect(event?.accountIds).toEqual([page]);
    expect(event?.accountIds).not.toContain(profile);
    expect(event?.accountIds).not.toContain(paused);
  });

  it('ne la suggère plus et refuse de l’ajouter deux fois', async () => {
    const { suggestions } = await worldDaySuggestions(db, people.editor, workspaceId, NOW);
    expect(suggestions.map((s) => s.id)).not.toContain('sida');
    await expect(addWorldDay(db, people.editor, workspaceId, 'sida', NOW)).rejects.toMatchObject({ code: 'journee_deja_ajoutee' });
  });

  it('deux clics simultanés ne créent qu’un événement', async () => {
    const results = await Promise.allSettled([addWorldDay(db, people.editor, workspaceId, 'personnes-handicapees', NOW), addWorldDay(db, people.editor, workspaceId, 'personnes-handicapees', NOW)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { events } = await listEvents(db, people.editor, workspaceId, '2026-11-23');
    expect(events.filter((e) => e.title === 'Journée internationale des personnes handicapées')).toHaveLength(1);
  });

  it('sans page : relayée par tous les comptes actifs', async () => {
    const id = await addWorldDay(db, people.editor, noPageWorkspace, 'sida', NOW);
    const { events } = await listEvents(db, people.editor, noPageWorkspace, '2026-11-23');
    expect([...(events.find((e) => e.id === id)?.accountIds ?? [])].sort()).toEqual([soloA, soloB].sort());
  });

  it('une date déjà passée cette année part l’année suivante', async () => {
    const id = await addWorldDay(db, people.editor, workspaceId, 'securite-sante-travail', NOW);
    const { events } = await listEvents(db, people.editor, workspaceId, '2026-11-23');
    expect(events.find((e) => e.id === id)?.startsOn).toBe('2027-04-28');
  });

  it('contrôle les droits et refuse une journée inconnue', async () => {
    await expect(addWorldDay(db, people.viewer, workspaceId, 'droits-femmes', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addWorldDay(db, people.stranger, workspaceId, 'droits-femmes', NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(worldDaySuggestions(db, people.stranger, workspaceId, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addWorldDay(db, people.editor, workspaceId, 'inconnue', NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect((await worldDaySuggestions(db, people.viewer, workspaceId, NOW)).canEdit).toBe(false);
  });
});

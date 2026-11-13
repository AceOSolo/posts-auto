import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import {
  type RowKey,
  addPlanningEntry,
  cellKey,
  deletePlanningEntry,
  getPlanningCell,
  importPlanning,
  parseRowKey,
  planningGrid,
  rowKeyToString,
  setAsidePlanningEntry,
  updatePlanningEntry,
  weekInventory,
} from './planning.ts';
import { deleteEvent, deleteSubject, importSubjects, listEvents, listSubjects, placeSubject, saveEvent, saveSubject } from './subjects-events.ts';

let db: Database;
let workspaceId: string;
let otherWorkspace: string;
let jp: string; // compte « Jean-Pierre »
let page: string; // compte « Secutop »
let foreignAccount: string;
const people = { editor: '', contributor: '', viewer: '', stranger: '' };
// Lundi 16 novembre 2026, 10h00 à Paris.
const NOW = new Date('2026-11-16T09:00:00Z');
const W47 = '2026-11-16';
const W48 = '2026-11-23';

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  otherWorkspace = (await createOrganization(db)).workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.contributor, 'contributor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  await addMember(db, otherWorkspace, people.stranger, 'admin');
  jp = await createAccount(db, workspaceId, { display_name: 'Jean-Pierre' });
  page = await createAccount(db, workspaceId, { display_name: 'Secutop', kind: 'page' });
  foreignAccount = await createAccount(db, otherWorkspace);
});
afterAll(() => closeTestDatabase(db));

const jpRow: RowKey = { kind: 'account', accountId: '' };
const row = (): RowKey => ({ ...jpRow, accountId: jp });

describe('lignes du planning', () => {
  it('se lisent et s’écrivent dans une adresse', () => {
    expect(parseRowKey(rowKeyToString({ kind: 'event', label: 'Salons : 2027' }))).toEqual({ kind: 'event', label: 'Salons : 2027' });
    expect(parseRowKey(`compte:${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`)).toMatchObject({ kind: 'account' });
    expect(parseRowKey('compte:pas-un-id')).toBeNull();
    expect(parseRowKey('autre:x')).toBeNull();
  });
});

describe('cases et sujets (PLA-01, PLA-02, PLA-07)', () => {
  it('l’éditeur ajoute plusieurs sujets à une case ; la vue montre les comptes et les lignes libres', async () => {
    await addPlanningEntry(db, people.editor, workspaceId, row(), W47, 'Webinaire DUERP', NOW);
    await addPlanningEntry(db, people.editor, workspaceId, row(), W47, ' Témoignage client ', NOW);
    await addPlanningEntry(db, people.editor, workspaceId, { kind: 'event', label: 'Salons' }, W48, 'Preventica', NOW);
    const grid = await planningGrid(db, people.viewer, workspaceId, { weeks: 4 }, NOW);
    expect(grid.currentWeek).toBe(W47);
    expect(grid.weeks.map((w) => [w.weekStart, w.isoWeek])).toEqual([
      [W47, 47],
      [W48, 48],
      ['2026-11-30', 49],
      ['2026-12-07', 50],
    ]);
    expect(grid.rows.map((r) => r.label)).toEqual(['Jean-Pierre', 'Secutop', 'Salons']);
    expect(grid.entries[cellKey(row(), W47)]?.map((e) => [e.position, e.content, e.status.state])).toEqual([
      [1, 'Webinaire DUERP', 'planned'],
      [2, 'Témoignage client', 'planned'],
    ]);
    expect(grid.canEdit).toBe(false);
  });

  it('l’état d’un sujet suit son post ; un sujet rédigé ne se supprime pas, il se met de côté', async () => {
    const cell = await getPlanningCell(db, people.editor, workspaceId, row(), W47);
    const first = cell.entries[0];
    if (first === undefined) throw new Error('sujet manquant');
    const postId = await createPost(db, workspaceId, jp, { planning_cell_id: first.id, status: 'valide' });
    const after = await getPlanningCell(db, people.editor, workspaceId, row(), W47);
    expect(after.entries[0]).toMatchObject({ status: { state: 'validated' }, posts: [{ id: postId, status: 'valide' }] });

    await expect(deletePlanningEntry(db, people.editor, workspaceId, first.id, NOW)).rejects.toMatchObject({ code: 'sujet_deja_redige' });
    await setAsidePlanningEntry(db, people.editor, workspaceId, first.id, 'Reporté en janvier', NOW);
    expect((await getPlanningCell(db, people.editor, workspaceId, row(), W47)).entries[0]).toMatchObject({ setAsideReason: 'Reporté en janvier', status: { state: 'set_aside' } });
    await setAsidePlanningEntry(db, people.editor, workspaceId, first.id, null, NOW);
    expect((await getPlanningCell(db, people.editor, workspaceId, row(), W47)).entries[0]?.status.state).toBe('validated');
    await expect(setAsidePlanningEntry(db, people.editor, workspaceId, first.id, '  ', NOW)).rejects.toMatchObject({ code: 'motif_requis' });
  });

  it('modifier et supprimer un sujet pas encore rédigé', async () => {
    const id = await addPlanningEntry(db, people.editor, workspaceId, row(), W48, 'Brouillon de sujet', NOW);
    await updatePlanningEntry(db, people.editor, workspaceId, id, 'Sujet précisé', NOW);
    expect((await getPlanningCell(db, people.editor, workspaceId, row(), W48)).entries.map((e) => e.content)).toContain('Sujet précisé');
    await deletePlanningEntry(db, people.editor, workspaceId, id, NOW);
    expect((await getPlanningCell(db, people.editor, workspaceId, row(), W48)).entries.map((e) => e.content)).not.toContain('Sujet précisé');
  });

  it('droits et contrôles : contributeur, autre client, semaine invalide, compte étranger', async () => {
    await expect(addPlanningEntry(db, people.contributor, workspaceId, row(), W47, 'x', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(planningGrid(db, people.stranger, workspaceId, {}, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addPlanningEntry(db, people.editor, workspaceId, row(), '2026-11-17', 'x', NOW)).rejects.toMatchObject({ code: 'semaine_invalide' });
    await expect(addPlanningEntry(db, people.editor, workspaceId, { kind: 'account', accountId: foreignAccount }, W47, 'x', NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getPlanningCell(db, people.editor, workspaceId, row(), '2026-11-18')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('inventaire de la semaine (PLA-08) : semaines en cours et suivante, sujets sans post d’abord', async () => {
    const { weeks, items } = await weekInventory(db, people.contributor, workspaceId, NOW);
    expect(weeks).toEqual([W47, W48]);
    expect(items[0]?.status.state).toBe('planned');
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['Jean-Pierre', 'Salons']));
    expect(items.at(-1)?.status.state).toBe('validated');
  });
});

describe('import du planning (PLA-05)', () => {
  it('crée les sujets, sans doublon ni compte étranger', async () => {
    const entries = [
      { rowKind: 'account' as const, accountId: page, rowLabel: null, weekStart: W48, content: 'Offre SST', sourceRef: 'Page | S48' },
      { rowKind: 'account' as const, accountId: page, rowLabel: null, weekStart: W48, content: 'offre sst ', sourceRef: 'Page | S48' },
      { rowKind: 'account' as const, accountId: foreignAccount, rowLabel: null, weekStart: W48, content: 'Intrus', sourceRef: 'x' },
      { rowKind: 'channel' as const, accountId: null, rowLabel: 'Newsletter', weekStart: W48, content: 'Lettre de décembre', sourceRef: 'Newsletter | S48' },
    ];
    expect(await importPlanning(db, people.editor, workspaceId, entries, NOW)).toEqual({ created: 2, skipped: 2 });
    expect(await importPlanning(db, people.editor, workspaceId, entries, NOW)).toEqual({ created: 0, skipped: 4 });
    await expect(importPlanning(db, people.contributor, workspaceId, entries, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('banque de sujets (PLA-03)', () => {
  it('sujets du compte et sujets communs ; placement dans une case ; import sans doublon', async () => {
    const own = await saveSubject(db, people.editor, workspaceId, null, { accountId: jp, subject: 'Former ses salariés', theme: 'SST', angle: null, format: null, offer: null, audience: null }, NOW);
    await saveSubject(db, people.editor, workspaceId, null, { accountId: null, subject: 'Sujet commun', theme: null, angle: null, format: null, offer: null, audience: null }, NOW);
    await saveSubject(db, people.editor, workspaceId, null, { accountId: page, subject: 'Sujet de la page', theme: null, angle: null, format: null, offer: null, audience: null }, NOW);
    expect((await listSubjects(db, people.viewer, workspaceId, jp)).subjects.map((s) => s.subject)).toEqual(['Former ses salariés', 'Sujet commun']);

    const cellId = await placeSubject(db, people.editor, workspaceId, own, jp, W48, NOW);
    expect((await getPlanningCell(db, people.editor, workspaceId, row(), W48)).entries.find((e) => e.id === cellId)).toMatchObject({ content: 'Former ses salariés', subjectId: own });
    await expect(placeSubject(db, people.editor, workspaceId, own, page, W48, NOW)).rejects.toMatchObject({ code: 'autre_compte' });

    await createPost(db, workspaceId, jp, { subject_id: own, scheduled_at: new Date('2026-11-26T11:00:00Z'), week_start: W48 });
    expect((await listSubjects(db, people.editor, workspaceId, jp)).subjects.find((s) => s.id === own)?.used).toBe(true);

    const rows = [
      { subject: 'Former ses salariés', theme: null, angle: null, format: null, offer: null, audience: null, published: false, sourceRef: 'ligne 2' },
      { subject: 'Prévenir les TMS', theme: 'TMS', angle: null, format: null, offer: null, audience: null, published: true, sourceRef: 'ligne 3' },
    ];
    expect(await importSubjects(db, people.editor, workspaceId, jp, rows, NOW)).toEqual({ created: 1, skipped: 1 });
    expect((await listSubjects(db, people.editor, workspaceId, jp)).subjects.find((s) => s.subject === 'Prévenir les TMS')?.published).toBe(true);
  });

  it('modification, suppression, contrôles', async () => {
    const id = await saveSubject(db, people.editor, workspaceId, null, { accountId: null, subject: 'À supprimer', theme: null, angle: null, format: null, offer: null, audience: null }, NOW);
    await saveSubject(db, people.editor, workspaceId, id, { accountId: null, subject: 'Renommé', theme: 'X', angle: null, format: null, offer: null, audience: null }, NOW);
    expect((await listSubjects(db, people.editor, workspaceId)).subjects.find((s) => s.id === id)?.subject).toBe('Renommé');
    await deleteSubject(db, people.editor, workspaceId, id, NOW);
    await expect(deleteSubject(db, people.editor, workspaceId, id, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveSubject(db, people.editor, workspaceId, null, { accountId: foreignAccount, subject: 'x', theme: null, angle: null, format: null, offer: null, audience: null }, NOW)).rejects.toMatchObject({ code: 'compte_inconnu' });
    await expect(saveSubject(db, people.contributor, workspaceId, null, { accountId: null, subject: 'x', theme: null, angle: null, format: null, offer: null, audience: null }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveSubject(db, people.editor, workspaceId, null, { accountId: null, subject: ' ', theme: null, angle: null, format: null, offer: null, audience: null }, NOW)).rejects.toMatchObject({ code: 'sujet_requis' });
  });
});

describe('événements (PLA-04)', () => {
  it('ajout avec ses comptes, relais visibles, modification, suppression', async () => {
    const id = await saveEvent(db, people.editor, workspaceId, null, { title: 'Preventica', startsOn: '2026-12-08', endsOn: '2026-12-10', link: 'https://preventica.com', accountIds: [jp, page, jp] }, NOW);
    const relay = await createPost(db, workspaceId, page, { event_id: id, origin: 'event', scheduled_at: new Date('2026-12-01T11:00:00Z'), week_start: '2026-11-30' });
    const { events, canEdit } = await listEvents(db, people.viewer, workspaceId, W47);
    expect(canEdit).toBe(false);
    expect(events.find((e) => e.id === id)).toMatchObject({ title: 'Preventica', endsOn: '2026-12-10', relays: [{ postId: relay, accountId: page }] });
    expect(new Set(events.find((e) => e.id === id)?.accountIds)).toEqual(new Set([jp, page]));

    await saveEvent(db, people.editor, workspaceId, id, { title: 'Preventica Paris', startsOn: '2026-12-08', accountIds: [page] }, NOW);
    expect((await listEvents(db, people.editor, workspaceId)).events.find((e) => e.id === id)).toMatchObject({ title: 'Preventica Paris', endsOn: null, accountIds: [page] });
    // Un événement terminé n'est plus listé à partir d'une date postérieure.
    expect((await listEvents(db, people.editor, workspaceId, '2026-12-09')).events.map((e) => e.id)).not.toContain(id);
    await deleteEvent(db, people.editor, workspaceId, id, NOW);
    expect((await listEvents(db, people.editor, workspaceId)).events.map((e) => e.id)).not.toContain(id);
  });

  it('contrôle des dates et des comptes', async () => {
    const base = { title: 'Salon', accountIds: [] };
    await expect(saveEvent(db, people.editor, workspaceId, null, { ...base, startsOn: '2026-02-30' }, NOW)).rejects.toMatchObject({ code: 'date_invalide' });
    await expect(saveEvent(db, people.editor, workspaceId, null, { ...base, startsOn: '2026-12-08', endsOn: '2026-12-01' }, NOW)).rejects.toMatchObject({ code: 'date_fin_invalide' });
    await expect(saveEvent(db, people.editor, workspaceId, null, { ...base, startsOn: '2026-12-08', accountIds: [foreignAccount] }, NOW)).rejects.toMatchObject({ code: 'compte_inconnu' });
    await expect(saveEvent(db, people.editor, workspaceId, null, { ...base, title: '', startsOn: '2026-12-08' }, NOW)).rejects.toMatchObject({ code: 'titre_requis' });
  });
});

describe('isolation', () => {
  it('aucun sujet, événement ou ligne d’un autre client n’apparaît', async () => {
    const grid = await planningGrid(db, people.stranger, otherWorkspace, {}, NOW);
    expect(Object.keys(grid.entries)).toEqual([]);
    expect((await listSubjects(db, people.stranger, otherWorkspace)).subjects).toEqual([]);
    expect((await listEvents(db, people.stranger, otherWorkspace)).events).toEqual([]);
    await asSystem(db, async (trx) => {
      const count = await trx.selectFrom('planning_cells').select('id').where('workspace_id', '=', otherWorkspace).execute();
      expect(count).toEqual([]);
    });
  });
});

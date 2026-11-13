import { DEFAULT_EDITORIAL_RULES } from '@posts-auto/core';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import {
  addReferencePost,
  deleteReferencePost,
  getAccountProfile,
  getLearnedPreferences,
  listReferencePosts,
  parseUsualSlots,
  saveAccountProfile,
  saveLearnedPreferences,
} from './account-profiles.ts';
import {
  type EditorialLineInput,
  deleteOfferItem,
  editorialHistory,
  getEditorialLine,
  listOffer,
  saveEditorialLine,
  saveOfferItem,
} from './editorial-line.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
const people = { editor: '', holder: '', contributor: '', viewer: '', stranger: '' };
const NOW = new Date('2026-11-16T09:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const LINE: EditorialLineInput = {
  positioning: '  Prévention des risques pour les PME  ',
  offers: null,
  audiences: 'Dirigeants',
  allowedProofs: null,
  tone: 'Direct, concret',
  bannedPhrases: ['leader du marché', ' Leader du marché ', '', 'n°1'],
  rules: { ...DEFAULT_EDITORIAL_RULES, maxLength: 1200 },
};

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.holder, 'contributor');
  await addMember(db, workspaceId, people.contributor, 'contributor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  await addMember(db, (await createOrganization(db)).workspaceIds[0] as string, people.stranger, 'admin');
  accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder, display_name: 'Jean-Pierre' });
});
afterAll(() => closeTestDatabase(db));

describe('ligne éditoriale (EDI-01, EDI-02, EDI-07)', () => {
  it('sans version enregistrée, les règles par défaut s’appliquent ; un lecteur lit sans modifier', async () => {
    const { line, canEdit } = await getEditorialLine(db, people.viewer, workspaceId);
    expect(line).toMatchObject({ version: 0, rules: DEFAULT_EDITORIAL_RULES, bannedPhrases: [] });
    expect(canEdit).toBe(false);
  });

  it('l’éditeur enregistre une version : textes nettoyés, formules dédoublonnées, trace d’audit', async () => {
    expect(await saveEditorialLine(db, people.editor, workspaceId, LINE, NOW)).toMatchObject({ version: 1 });
    const { line, canEdit } = await getEditorialLine(db, people.editor, workspaceId);
    expect(canEdit).toBe(true);
    expect(line).toMatchObject({ version: 1, positioning: 'Prévention des risques pour les PME', bannedPhrases: ['leader du marché', 'n°1'], savedBy: 'editor' });
    expect(line.rules.maxLength).toBe(1200);
    const logged = await asSystem(db, (trx) => trx.selectFrom('audit_log').select('action').where('workspace_id', '=', workspaceId).execute());
    expect(logged.map((l) => l.action)).toContain('ligne_editoriale.modifiee');
  });

  it('enregistrer sans changement ne crée pas de version ; un changement en crée une, visible dans l’historique', async () => {
    expect(await saveEditorialLine(db, people.editor, workspaceId, LINE, later(1))).toEqual({ version: 1, changed: [] });
    expect(await saveEditorialLine(db, people.editor, workspaceId, { ...LINE, tone: 'Chaleureux' }, later(2))).toEqual({ version: 2, changed: ['Ton'] });
    const history = await editorialHistory(db, people.viewer, workspaceId);
    expect(history.map((h) => [h.version, h.changed])).toEqual([
      [2, ['Ton']],
      [1, ['Première version']],
    ]);
  });

  it('un contributeur ne modifie pas la ligne ; une personne d’un autre client ne la voit pas', async () => {
    await expect(saveEditorialLine(db, people.contributor, workspaceId, LINE, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getEditorialLine(db, people.stranger, workspaceId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('état de l’offre (EDI-03)', () => {
  it('ajout, modification, suppression ; la disponibilité est contrôlée', async () => {
    const id = await saveOfferItem(db, people.editor, workspaceId, null, { name: 'Formation SST', status: 'available', pricing: 'paid' }, NOW);
    await saveOfferItem(db, people.editor, workspaceId, null, { name: 'Application mobile', status: 'planned' }, NOW);
    await saveOfferItem(db, people.editor, workspaceId, id, { name: 'Formation SST', description: 'Deux jours', status: 'available', pricing: 'paid' }, NOW);
    const { items } = await listOffer(db, people.viewer, workspaceId);
    expect(items.map((i) => [i.name, i.status, i.pricing, i.description])).toEqual([
      ['Formation SST', 'available', 'paid', 'Deux jours'],
      ['Application mobile', 'planned', null, null],
    ]);
    await expect(saveOfferItem(db, people.editor, workspaceId, null, { name: ' ', status: 'available' }, NOW)).rejects.toMatchObject({ code: 'nom_requis' });
    await expect(saveOfferItem(db, people.editor, workspaceId, null, { name: 'X', status: 'bientot' as 'planned' }, NOW)).rejects.toMatchObject({ code: 'statut_invalide' });
    await expect(saveOfferItem(db, people.contributor, workspaceId, null, { name: 'X', status: 'available' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteOfferItem(db, people.editor, workspaceId, id, NOW);
    expect((await listOffer(db, people.editor, workspaceId)).items).toHaveLength(1);
    await expect(deleteOfferItem(db, people.editor, workspaceId, id, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('fiche du compte (EDI-04)', () => {
  it('l’éditeur règle toute la fiche, créneaux habituels compris', async () => {
    const slots = [
      { weekday: 4, time: '09:00' },
      { weekday: 2, time: '12:00' },
      { weekday: 2, time: '12:00' },
    ] as const;
    await saveAccountProfile(db, people.editor, accountId, { voice: 'je', sensitivity: 'prudent', postsPerWeek: 2, optionalPerWeek: 1, usualSlots: [...slots] }, NOW);
    const { profile, rights } = await getAccountProfile(db, people.editor, accountId);
    expect(profile).toMatchObject({
      voice: 'je',
      sensitivity: 'prudent',
      postsPerWeek: 2,
      optionalPerWeek: 1,
      usualSlots: [
        { weekday: 2, time: '12:00' },
        { weekday: 4, time: '09:00' },
      ],
    });
    expect(rights).toEqual({ canEditAll: true, canEditOwn: false });
  });

  it('le titulaire règle son ton et ses sujets à éviter, pas son rythme (matrice 3.3)', async () => {
    await saveAccountProfile(db, people.holder, accountId, { tenor: 'Sobre', avoid: 'La politique' }, NOW);
    expect((await getAccountProfile(db, people.holder, accountId)).profile).toMatchObject({ tenor: 'Sobre', avoid: 'La politique', postsPerWeek: 2 });
    await expect(saveAccountProfile(db, people.holder, accountId, { postsPerWeek: 5 }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveAccountProfile(db, people.contributor, accountId, { tenor: 'x' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuse un rythme ou une sensibilité invalides', async () => {
    await expect(saveAccountProfile(db, people.editor, accountId, { postsPerWeek: 20 }, NOW)).rejects.toMatchObject({ code: 'rythme_invalide' });
    await expect(saveAccountProfile(db, people.editor, accountId, { sensitivity: 'extreme' as 'strict' }, NOW)).rejects.toMatchObject({ code: 'sensibilite_invalide' });
  });

  it('ne garde que les créneaux valides', () => {
    expect(parseUsualSlots([{ weekday: 8, time: '12:00' }, { weekday: 1, time: '25:00' }, { weekday: 5, time: '17:30' }, 'x', null])).toEqual([{ weekday: 5, time: '17:30' }]);
    expect(parseUsualSlots('pas une liste')).toEqual([]);
  });
});

describe('exemples et préférences (EDI-05, EDI-06)', () => {
  it('le titulaire ajoute et retire ses exemples ; un autre contributeur ne le peut pas', async () => {
    const id = await addReferencePost(db, people.holder, accountId, { body: 'Un post réussi.', label: 'imiter', note: 'Bon ton' }, NOW);
    await addReferencePost(db, people.editor, accountId, { body: 'Trop commercial.', label: 'eviter' }, later(1));
    expect((await listReferencePosts(db, people.viewer, accountId)).map((r) => [r.label, r.body])).toEqual([
      ['eviter', 'Trop commercial.'],
      ['imiter', 'Un post réussi.'],
    ]);
    await expect(addReferencePost(db, people.contributor, accountId, { body: 'x', label: 'imiter' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addReferencePost(db, people.holder, accountId, { body: '  ', label: 'imiter' }, NOW)).rejects.toMatchObject({ code: 'texte_requis' });
    await deleteReferencePost(db, people.holder, accountId, id, NOW);
    expect(await listReferencePosts(db, people.holder, accountId)).toHaveLength(1);
  });

  it('le résumé des préférences est visible et modifiable', async () => {
    expect(await getLearnedPreferences(db, people.viewer, accountId)).toEqual({ summary: '', updatedAt: null });
    await saveLearnedPreferences(db, people.holder, accountId, '  Phrases courtes, pas de jargon. ', NOW);
    expect((await getLearnedPreferences(db, people.editor, accountId)).summary).toBe('Phrases courtes, pas de jargon.');
  });
});

import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { FakeImageGenerator, galleryTemplates } from '@posts-auto/visuals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, RefusedError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { addLibraryPhotos, listLibrary, parseTags, removeFromLibrary, updateLibraryPhoto } from './library.ts';
import { duplicateTemplate, getTemplate, getTemplateLibrary, recolorGalleryTemplates, saveBranding, saveTemplate, setTemplateArchived } from './templates.ts';

let db: Database;
let workspaceId: string;
let otherWorkspace: string;
let accountId: string;
let foreignAccount: string;
const people = { admin: '', editor: '', contributor: '', viewer: '' };
const NOW = new Date('2026-11-16T09:00:00Z');
const stored = new Map<string, Uint8Array>();
const media: MediaWriter = { write: async (key, bytes) => void stored.set(key, bytes) };
const png = async (subject: string) => (await new FakeImageGenerator().generate({ subject, width: 300, height: 200 })).bytes;
const BRAND = { primary: '#0f3d5e', secondary: '#f0a500', light: '#f5f7fa', dark: '#1a1a1a' };

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db, { workspaces: 2 });
  workspaceId = org.workspaceIds[0] as string;
  otherWorkspace = org.workspaceIds[1] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.admin, 'admin');
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.contributor, 'contributor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  accountId = await createAccount(db, workspaceId, { display_name: 'Marie' });
  foreignAccount = await createAccount(db, otherWorkspace);
});
afterAll(() => closeTestDatabase(db));

describe('bibliothèque de modèles (VIS-01, VIS-02)', () => {
  it('un lecteur voit la bibliothèque sans pouvoir la modifier, et sa visite ne copie rien', async () => {
    const library = await getTemplateLibrary(db, people.viewer, workspaceId, NOW);
    expect(library).toMatchObject({ templates: [], canManage: false, canSetBudget: false, imageBudget: { monthly: 30, used: 0 } });
  });

  it('la première visite d’une éditrice copie les modèles de départ', async () => {
    const library = await getTemplateLibrary(db, people.editor, workspaceId, NOW);
    expect(library.templates.map((t) => [t.name, t.hasPhoto, t.hasBullets])).toEqual([
      ['Titre et points clés', false, true],
      ['Photo et titre', true, false],
      ['Citation', false, false],
      ['Photo pleine page', true, false],
    ]);
    expect(library).toMatchObject({ canManage: true, canSetBudget: false, accounts: [{ id: accountId, name: 'Marie' }] });
  });

  it('enregistre un modèle valide, réservé à un compte de l’espace', async () => {
    const definition = galleryTemplates()[1]?.definition;
    const id = await saveTemplate(db, people.editor, workspaceId, { id: null, name: '  Annonce  ', accountId, definition }, NOW);
    const detail = await getTemplate(db, people.editor, id);
    expect(detail).toMatchObject({ name: 'Annonce', accountId, canManage: true, archived: false });
    expect(detail.definition).toEqual(definition);
    await expect(saveTemplate(db, people.editor, workspaceId, { id: null, name: 'Intrus', accountId: foreignAccount, definition }, NOW)).rejects.toMatchObject({ code: 'compte_inconnu' });
  });

  it('refuse une définition invalide avec un message lisible, ou sans zone de titre', async () => {
    const broken = { format: 'square', background: 'bleu', zones: [{ key: 'titre', kind: 'title', box: { x: 0, y: 0, w: 10, h: 10 }, style: { color: '#000000', maxSize: 40 } }] };
    await expect(saveTemplate(db, people.editor, workspaceId, { id: null, name: 'Cassé', accountId: null, definition: broken }, NOW)).rejects.toMatchObject({
      code: 'modele_invalide',
      message: 'background : couleur #rrggbb attendue.',
    });
    const noTitle = { format: 'square', background: '#ffffff', zones: [{ key: 'photo', kind: 'photo', box: { x: 0, y: 0, w: 10, h: 10 } }] };
    await expect(saveTemplate(db, people.editor, workspaceId, { id: null, name: 'Sans titre', accountId: null, definition: noTitle }, NOW)).rejects.toMatchObject({ code: 'modele_invalide' });
    await expect(saveTemplate(db, people.contributor, workspaceId, { id: null, name: 'X', accountId: null, definition: galleryTemplates()[0]?.definition }, NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('duplique, archive et restaure un modèle', async () => {
    // Choisi par sa clé : l'ordre de la bibliothèque dépend des dates de création.
    const first = (await getTemplateLibrary(db, people.editor, workspaceId, NOW)).templates.find((t) => t.galleryKey === 'titre-points');
    const copy = await duplicateTemplate(db, people.editor, first?.id as string, NOW);
    expect((await getTemplate(db, people.editor, copy)).name).toBe('Titre et points clés (copie)');
    await setTemplateArchived(db, people.editor, copy, true, NOW);
    const library = await getTemplateLibrary(db, people.editor, workspaceId, NOW);
    expect(library.templates.at(-1)).toMatchObject({ id: copy, archived: true });
    await setTemplateArchived(db, people.editor, copy, false, NOW);
    expect((await getTemplate(db, people.editor, copy)).archived).toBe(false);
  });
});

describe('charte et budget d’images (ONB-05, VIS-05)', () => {
  it('les couleurs et le logo de la charte ; les modèles de départ reprennent les couleurs à la demande', async () => {
    await saveBranding(db, media, people.editor, workspaceId, { ...BRAND, primary: '#AA0000', font: 'montserrat', logo: { bytes: await png('logo') } }, NOW);
    const library = await getTemplateLibrary(db, people.editor, workspaceId, NOW);
    expect(library.branding).toMatchObject({ primary: '#aa0000', font: 'montserrat', logoAssetId: expect.any(String) });
    expect(stored.has(`${workspaceId}/charte/${library.branding.logoAssetId}.png`)).toBe(true);

    expect(await recolorGalleryTemplates(db, people.editor, workspaceId, NOW)).toBe(4);
    const recolored = await getTemplate(db, people.editor, library.templates.find((t) => t.galleryKey === 'titre-points')?.id as string);
    expect(recolored.definition.background).toBe('#aa0000');
    expect(recolored.definition.zones.find((z) => z.kind === 'title')?.style?.font).toBe('montserrat');

    await saveBranding(db, media, people.editor, workspaceId, { ...BRAND, logo: null }, NOW);
    const after = (await getTemplateLibrary(db, people.editor, workspaceId, NOW)).branding;
    // Logo retiré ; la police, absente du formulaire, est gardée.
    expect(after).toMatchObject({ logoAssetId: null, font: 'montserrat' });
    await expect(saveBranding(db, media, people.editor, workspaceId, { ...BRAND, font: 'comic' as never }, NOW)).rejects.toMatchObject({ code: 'police_inconnue' });
  });

  it('refuse une couleur invalide ; seuls le propriétaire et les admins fixent le budget', async () => {
    await expect(saveBranding(db, media, people.editor, workspaceId, { ...BRAND, dark: 'noir' }, NOW)).rejects.toMatchObject({ code: 'couleur_invalide' });
    await expect(saveBranding(db, media, people.editor, workspaceId, { ...BRAND, imageBudgetMonthly: 50 }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveBranding(db, media, people.admin, workspaceId, { ...BRAND, imageBudgetMonthly: -2 }, NOW)).rejects.toMatchObject({ code: 'budget_invalide' });
    await saveBranding(db, media, people.admin, workspaceId, { ...BRAND, imageBudgetMonthly: 50 }, NOW);
    await asSystem(db, (trx) =>
      trx.insertInto('ai_usage').values({ workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'image', kind: 'image', units: 1, at: new Date('2026-11-03T10:00:00Z') }).execute(),
    );
    expect((await getTemplateLibrary(db, people.admin, workspaceId, NOW)).imageBudget).toEqual({ monthly: 50, used: 1 });
  });
});

describe('médiathèque (VIS-08)', () => {
  it('lit les mots-clés saisis', () => {
    expect(parseTags('Chantier, sécurité ;  CHANTIER\nÉquipe de nuit')).toEqual(['chantier', 'sécurité', 'équipe de nuit']);
  });

  it('un contributeur ajoute des photos classées ; elles se filtrent par dossier et mot-clé', async () => {
    const count = await addLibraryPhotos(
      db,
      media,
      people.contributor,
      workspaceId,
      [{ bytes: await png('atelier'), label: 'Atelier bois' }, { bytes: await png('scie') }],
      { folder: ' Chantiers ', tags: 'bois, machines' },
      NOW,
    );
    expect(count).toBe(2);
    await addLibraryPhotos(db, media, people.editor, workspaceId, [{ bytes: await png('salle'), label: 'Salle de formation' }], { folder: 'Locaux', tags: 'formation' }, NOW);
    const all = await listLibrary(db, people.contributor, workspaceId);
    expect(all).toMatchObject({ folders: ['Chantiers', 'Locaux'], tags: ['bois', 'formation', 'machines'], canAdd: true });
    expect(all.photos.find((p) => p.label === 'Atelier bois')).toMatchObject({ folder: 'Chantiers', tags: ['bois', 'machines'], width: 300, height: 200, canEdit: true });
    expect(all.photos.find((p) => p.label === 'Salle de formation')?.canEdit).toBe(false);
    expect((await listLibrary(db, people.contributor, workspaceId, { tag: 'Formation' })).photos.map((p) => p.label)).toEqual(['Salle de formation']);
    expect((await listLibrary(db, people.contributor, workspaceId, { folder: 'Chantiers' })).photos).toHaveLength(2);
  });

  it('refuse un lecteur, et un fichier qui n’est pas une image', async () => {
    await expect(addLibraryPhotos(db, media, people.viewer, workspaceId, [{ bytes: await png('x') }], {}, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    const refused = addLibraryPhotos(db, media, people.contributor, workspaceId, [{ bytes: new TextEncoder().encode('pas une image') }], {}, NOW);
    await expect(refused).rejects.toBeInstanceOf(RefusedError);
    await expect(refused).rejects.toMatchObject({ code: 'image_unsupported' });
  });

  it('l’auteur ou la gestion du contenu classe et retire une photo ; les autres non', async () => {
    const photos = (await listLibrary(db, people.editor, workspaceId)).photos;
    const atelier = photos.find((p) => p.label === 'Atelier bois')?.id as string;
    const salle = photos.find((p) => p.label === 'Salle de formation')?.id as string;
    await updateLibraryPhoto(db, people.contributor, atelier, { label: 'Atelier', folder: 'Ateliers', tags: 'bois' }, NOW);
    await expect(updateLibraryPhoto(db, people.contributor, salle, { label: 'X' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await removeFromLibrary(db, people.editor, atelier, NOW);
    const after = await listLibrary(db, people.editor, workspaceId);
    expect(after.photos.map((p) => p.label)).not.toContain('Atelier');
    // La photo reste en base (un post peut l'utiliser), hors de la médiathèque.
    const row = await asSystem(db, (trx) => trx.selectFrom('media_assets').select(['in_library', 'folder']).where('id', '=', atelier).executeTakeFirstOrThrow());
    expect(row).toEqual({ in_library: false, folder: 'Ateliers' });
  });
});

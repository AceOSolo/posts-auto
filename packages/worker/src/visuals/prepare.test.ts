import { FakeModel, ModelError } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createOrganization, createPost, openTestDatabase } from '@posts-auto/db/testing';
import { FakeImageGenerator, imageSize } from '@posts-auto/visuals';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryMediaStore } from '../media/media-store.ts';
import { type AccountVisual, type VisualContext, type VisualDeps, loadAccountVisuals, loadVisualContext, prepareVisual, storeVisual } from './prepare.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
let media: MemoryMediaStore;
let images: FakeImageGenerator;
const NOW = new Date('2026-11-16T09:00:00Z');
const POST = 'Démonstration : la sécurité sur les chantiers\n\nTexte du post.';

const deps = (overrides: Partial<VisualDeps> = {}): VisualDeps => ({ model: new FakeModel(), media, images, ...overrides });
const context = () => asSystem(db, (trx) => loadVisualContext(trx, media, workspaceId, NOW));
const account = async (): Promise<AccountVisual> => (await asSystem(db, (trx) => loadAccountVisuals(trx, [accountId], NOW))).get(accountId) as AccountVisual;
const store = (prepared: NonNullable<Awaited<ReturnType<typeof prepareVisual>>>, postId: string, replacesAssetId?: string) =>
  asSystem(db, (trx) => storeVisual(trx, prepared, { workspaceId, accountId, postId, runId: null, usdToEur: 0.86, replacesAssetId: replacesAssetId ?? null }, NOW));
const postMedia = (postId: string) =>
  asSystem(db, (trx) =>
    trx
      .selectFrom('post_media as pm')
      .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
      .select(['pm.position', 'pm.alt_text', 'm.id', 'm.kind', 'm.ai_generated', 'm.template_id', 'm.source_asset_id', 'm.render_content'])
      .where('pm.post_id', '=', postId)
      .orderBy('pm.position')
      .execute(),
  );

async function libraryPhoto(label: string, tags: string[] = []): Promise<string> {
  const bytes = (await new FakeImageGenerator().generate({ subject: label, width: 400, height: 300 })).bytes;
  return asSystem(db, async (trx) => {
    const row = await trx
      .insertInto('media_assets')
      .values({ workspace_id: workspaceId, kind: 'upload', storage_key: `${workspaceId}/photos/${label.replace(/\W+/g, '-')}.png`, mime: 'image/png', in_library: true, label, tags })
      .returning(['id', 'storage_key'])
      .executeTakeFirstOrThrow();
    await media.write(row.storage_key, bytes);
    return row.id;
  });
}

beforeAll(async () => {
  db = await openTestDatabase();
});
afterAll(() => closeTestDatabase(db));

beforeEach(async () => {
  // Un espace neuf par test : modèles, budget et historique repartent de zéro.
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  accountId = await createAccount(db, workspaceId, { display_name: 'Marie Dupont' });
  media = new MemoryMediaStore();
  images = new FakeImageGenerator();
});

describe('préparation d’un visuel (VIS-03, VIS-04, VIS-05, VIS-12)', () => {
  it('copie les modèles de départ au premier besoin', async () => {
    const ctx = await context();
    expect(ctx.templates.map((t) => t.name).sort()).toEqual(['Citation', 'Photo et titre', 'Photo pleine page', 'Titre et points clés']);
    expect(ctx.imagesLeft).toBe(30);
  });

  it('premier visuel du compte : image générée dans un modèle à photo, marquée comme générée par IA (REC-18)', async () => {
    const ctx = await context();
    const acc = await account();
    expect(acc).toMatchObject({ name: 'Marie Dupont', ratio: 0.5, history: [] });
    const prepared = await prepareVisual(deps(), ctx, acc, { accountId, postText: POST, summary: 'Sécurité', withPhoto: true });
    expect(prepared).not.toBeNull();
    const visual = prepared as NonNullable<typeof prepared>;
    expect(images.requests).toHaveLength(1);
    expect(images.requests[0]).toMatchObject({ subject: expect.stringMatching(/Bureau lumineux/) });
    expect(visual).toMatchObject({ aiGenerated: true, issues: [], width: 1080 });
    expect(visual.altText).toMatch(/Illustration générée par IA\.$/);
    expect(visual.content).toMatchObject({ title: 'la sécurité sur les chantiers', photo: 'generated', signature: 'Marie Dupont', notes: [] });
    expect(ctx.imagesLeft).toBe(29);
    // Rendu réel, à la taille du modèle choisi.
    expect(await imageSize(await media.read(visual.storageKey))).toEqual({ width: visual.width, height: visual.height });

    const postId = await createPost(db, workspaceId, accountId);
    await store(visual, postId);
    const rows = await postMedia(postId);
    expect(rows).toEqual([expect.objectContaining({ position: 1, kind: 'rendered', ai_generated: true, source_asset_id: visual.photoAssetId, template_id: visual.templateId })]);
    const usage = await asSystem(db, (trx) => trx.selectFrom('ai_usage').select(['purpose', 'kind', 'units', 'counted_in_quota']).where('post_id', '=', postId).orderBy('purpose').execute());
    // Remplissage du modèle et contrôle de l'image (VIS-11) : deux appels à l'IA.
    expect(usage).toEqual([
      { purpose: 'image', kind: 'image', units: 1, counted_in_quota: true },
      { purpose: 'visual', kind: 'text', units: 0, counted_in_quota: false },
      { purpose: 'visual', kind: 'text', units: 0, counted_in_quota: false },
    ]);
    // Le texte alternatif dit ce que montre vraiment l'image, relevé au contrôle.
    expect(visual.altText).toBe('la sécurité sur les chantiers. Image abstraite en dégradé de couleurs (démonstration). Illustration générée par IA.');
    const photo = await asSystem(db, (trx) => trx.selectFrom('media_assets').select(['kind', 'ai_generated', 'generator', 'prompt', 'in_library']).where('id', '=', visual.photoAssetId as string).executeTakeFirstOrThrow());
    expect(photo).toMatchObject({ kind: 'generated', ai_generated: true, generator: 'simulation/simulation', in_library: false });
    expect(photo.prompt).toMatch(/Aucune personne identifiable/);
  });

  it('alterne : après un visuel avec photo, un visuel texte (VIS-04)', async () => {
    const ctx = await context();
    const first = await prepareVisual(deps(), ctx, await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    await store(first as NonNullable<typeof first>, await createPost(db, workspaceId, accountId));
    expect((await account()).history).toEqual([true]);
    const second = await prepareVisual(deps(), ctx, await account(), { accountId, postText: POST, summary: 'S', withPhoto: false });
    expect(second).toMatchObject({ aiGenerated: false, photoAssetId: null, content: { photo: null } });
    expect(images.requests).toHaveLength(1);
  });

  it('préfère une photo de la médiathèque qui convient (VIS-08)', async () => {
    const photo = await libraryPhoto('Chantier de gros œuvre', ['sécurité']);
    const prepared = await prepareVisual(deps(), await context(), await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    expect(prepared).toMatchObject({ photoAssetId: photo, aiGenerated: false, generated: null, content: { photo: 'library' } });
    expect(prepared?.altText).not.toMatch(/générée par IA/);
    expect(images.requests).toHaveLength(0);
  });

  it('budget du mois atteint : visuel texte, sans appel au générateur (VIS-05)', async () => {
    await asSystem(db, (trx) => trx.updateTable('workspaces').set({ image_budget_monthly: 0 }).where('id', '=', workspaceId).execute());
    const prepared = await prepareVisual(deps(), await context(), await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    expect(prepared).toMatchObject({ photoAssetId: null, content: { photo: null, notes: [expect.stringMatching(/Budget d’images/)] } });
    expect(images.requests).toHaveLength(0);
  });

  it('le budget compte les images déjà générées ce mois-ci, pas celles du mois précédent', async () => {
    await asSystem(db, (trx) =>
      trx
        .insertInto('ai_usage')
        .values([
          { workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'image', kind: 'image', units: 1, at: new Date('2026-11-02T08:00:00Z') },
          // Heure d'hiver depuis le 25 octobre : Paris est à UTC+1.
          { workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'image', kind: 'image', units: 1, at: new Date('2026-10-31T23:30:00Z') }, // 1er novembre, 0h30 à Paris
          { workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'image', kind: 'image', units: 1, at: new Date('2026-10-31T22:30:00Z') }, // 31 octobre, 23h30 à Paris
        ])
        .execute(),
    );
    expect((await context()).imagesLeft).toBe(28);
  });

  it('sans générateur configuré, ou générateur en panne : visuel texte, budget intact', async () => {
    const without = await prepareVisual(deps({ images: null }), await context(), await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    expect(without?.content.notes).toEqual([expect.stringMatching(/Aucun générateur/)]);
    const ctx = await context();
    const broken = { provider: 'panne', generate: async () => Promise.reject(new Error('service indisponible')) };
    const failed = await prepareVisual(deps({ images: broken }), ctx, await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    expect(failed).toMatchObject({ photoAssetId: null, content: { notes: [expect.stringMatching(/service indisponible/)] } });
    expect(ctx.imagesLeft).toBe(30);
  });

  it('IA indisponible : titre repris du sujet, visuel quand même', async () => {
    const model = new FakeModel(() => {
      throw new ModelError('unavailable', 'surcharge');
    });
    const prepared = await prepareVisual(deps({ model }), await context(), await account(), { accountId, postText: POST, summary: 'Le sujet du post', withPhoto: false });
    expect(prepared?.content).toMatchObject({ title: 'Le sujet du post', bullets: [], notes: [expect.stringMatching(/l’IA n’a pas répondu/)] });
  });

  it('aucun modèle actif : pas de visuel', async () => {
    await context();
    await asSystem(db, (trx) => trx.updateTable('templates').set({ archived_at: NOW }).where('workspace_id', '=', workspaceId).execute());
    expect(await prepareVisual(deps(), await context(), await account(), { accountId, postText: POST, summary: 'S', withPhoto: true })).toBeNull();
  });

  it('prend les modèles réservés au compte quand il en a', async () => {
    const ctx0 = await context();
    const photoTemplate = ctx0.templates.find((t) => t.name === 'Photo pleine page') as VisualContext['templates'][number];
    const own = await asSystem(db, (trx) =>
      trx
        .insertInto('templates')
        .values({ workspace_id: workspaceId, account_id: accountId, name: 'Le mien', format: 'portrait', definition: JSON.stringify(photoTemplate.definition) })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const prepared = await prepareVisual(deps(), await context(), await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    expect(prepared?.templateId).toBe(own.id);
  });
});

describe('contrôle des images générées (VIS-11)', () => {
  /** Modèle simulé : remplissage par défaut, et le contrôle répond tour à tour par `verdicts` (null : l'IA ne répond pas). */
  const inspecting = (verdicts: readonly (Record<string, boolean> | null)[]) => {
    let checks = 0;
    return new FakeModel((request, index) => {
      if ((request.images?.length ?? 0) === 0) return demoFill(request.task);
      const verdict = verdicts[Math.min(checks, verdicts.length - 1)];
      checks += 1;
      if (verdict === null) throw new ModelError('unavailable', `panne ${index}`);
      return { identifiablePerson: false, visibleText: false, logoOrBrand: false, defects: false, shocking: false, description: 'Un atelier vu de loin', ...verdict };
    });
  };
  const demoFill = (task: string) => ({
    title: 'Sécurité sur les chantiers',
    subtitle: '',
    bullets: [],
    libraryPhotoId: '',
    imageSubject: task.startsWith('Une photo est demandée') ? 'Chantier au lever du jour' : '',
    altText: 'Visuel',
    ignoredInstructions: [],
  });
  const usageOf = (postId: string) =>
    asSystem(db, (trx) => trx.selectFrom('ai_usage').select(['purpose', 'units']).where('post_id', '=', postId).where('kind', '=', 'image').execute());

  it('une image écartée est refaite une fois, en précisant ce qu’il faut éviter ; les deux comptent', async () => {
    const ctx = await context();
    const prepared = await prepareVisual(deps({ model: inspecting([{ identifiablePerson: true }, {}]) }), ctx, await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    expect(images.requests.map((r) => r.subject)).toEqual(['Chantier au lever du jour', 'Chantier au lever du jour Éviter absolument : personne identifiable.']);
    expect(prepared).toMatchObject({ aiGenerated: true, content: { photo: 'generated', notes: ['Image écartée au contrôle : personne identifiable.'] } });
    expect(prepared?.imageCosts).toHaveLength(2);
    expect(ctx.imagesLeft).toBe(28);
    const postId = await createPost(db, workspaceId, accountId);
    await store(prepared as NonNullable<typeof prepared>, postId);
    expect(await usageOf(postId)).toEqual([
      { purpose: 'image', units: 1 },
      { purpose: 'image', units: 1 },
    ]);
  });

  it('deux images écartées : visuel texte, sans troisième essai (RÈG-19)', async () => {
    const prepared = await prepareVisual(deps({ model: inspecting([{ visibleText: true }, { logoOrBrand: true }]) }), await context(), await account(), {
      accountId,
      postText: POST,
      summary: 'S',
      withPhoto: true,
    });
    expect(images.requests).toHaveLength(2);
    expect(prepared).toMatchObject({ aiGenerated: false, photoAssetId: null, generated: null, content: { photo: null } });
    expect(prepared?.content.notes).toEqual([
      'Image écartée au contrôle : texte ou chiffres visibles.',
      'Image écartée au contrôle : logo ou marque.',
      expect.stringMatching(/Déjà 2 images générées/),
    ]);
    expect(prepared?.imageCosts).toHaveLength(2);
  });

  it('contrôle impossible (IA indisponible) : image gardée, à vérifier', async () => {
    const prepared = await prepareVisual(deps({ model: inspecting([null]) }), await context(), await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    expect(prepared).toMatchObject({ aiGenerated: true, content: { photo: 'generated', notes: [expect.stringMatching(/Image non contrôlée/)] } });
    expect(images.requests).toHaveLength(1);
  });
});

describe('refaire le visuel (VIS-13)', () => {
  it('garde la photo et le modèle, remplace le visuel à sa place', async () => {
    const ctx = await context();
    const postId = await createPost(db, workspaceId, accountId);
    const first = (await prepareVisual(deps(), ctx, await account(), { accountId, postText: POST, summary: 'S', withPhoto: true })) as NonNullable<Awaited<ReturnType<typeof prepareVisual>>>;
    await store(first, postId);
    const photo = await asSystem(db, (trx) => trx.selectFrom('media_assets').select(['id', 'storage_key', 'ai_generated']).where('id', '=', first.photoAssetId as string).executeTakeFirstOrThrow());

    const model = new FakeModel((request) => {
      expect(request.task).toContain('Consigne de l’équipe pour refaire le visuel : Titre plus court');
      expect(request.task).toContain('Ce visuel est sans photo'); // la photo est gardée : rien à choisir
      return { title: 'Plus court', subtitle: '', bullets: [], libraryPhotoId: '', imageSubject: '', altText: 'Visuel', ignoredInstructions: [] };
    });
    const redo = await prepareVisual(deps({ model }), ctx, await account(), {
      accountId,
      postText: POST,
      summary: 'S',
      withPhoto: false,
      instruction: 'Titre plus court',
      previous: { assetId: first.assetId, templateId: first.templateId, title: first.content.title, bullets: first.content.bullets, photo: { assetId: photo.id, storageKey: photo.storage_key, aiGenerated: photo.ai_generated } },
      imagesForPost: 1,
    });
    expect(redo).toMatchObject({ templateId: first.templateId, photoAssetId: photo.id, aiGenerated: true, generated: null, content: { title: 'Plus court', photo: 'kept', instruction: 'Titre plus court' } });
    expect(images.requests).toHaveLength(1);
    await store(redo as NonNullable<typeof redo>, postId, first.assetId);
    expect((await postMedia(postId)).map((m) => [m.position, m.id])).toEqual([[1, (redo as NonNullable<typeof redo>).assetId]]);
  });

  it('nouvelle photo demandée : au plus deux images générées par post (RÈG-19)', async () => {
    const prepared = await prepareVisual(deps(), await context(), await account(), { accountId, postText: POST, summary: 'S', withPhoto: true, newPhoto: true, imagesForPost: 2 });
    expect(prepared?.content.notes).toEqual([expect.stringMatching(/Déjà 2 images générées/)]);
    expect(images.requests).toHaveLength(0);
  });

  it('un visuel ajouté à un post qui a déjà des photos devient la couverture', async () => {
    const postId = await createPost(db, workspaceId, accountId);
    const upload = await asSystem(db, async (trx) => {
      const asset = await trx.insertInto('media_assets').values({ workspace_id: workspaceId, kind: 'upload', storage_key: `${workspaceId}/p/1.png`, mime: 'image/png' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: postId, asset_id: asset.id, position: 1 }).execute();
      return asset.id;
    });
    const prepared = await prepareVisual(deps(), await context(), await account(), { accountId, postText: POST, summary: 'S', withPhoto: false });
    await store(prepared as NonNullable<typeof prepared>, postId);
    expect((await postMedia(postId)).map((m) => [m.position, m.kind])).toEqual([
      [1, 'rendered'],
      [2, 'upload'],
    ]);
    expect((await postMedia(postId))[1]?.id).toBe(upload);
  });

  it('VIS-06 : l’avatar autorisé du titulaire remplace l’image générée, sur son compte seulement', async () => {
    const other = await createAccount(db, workspaceId, { display_name: 'Autre compte' });
    const bytes = (await new FakeImageGenerator().generate({ subject: 'avatar', width: 400, height: 400 })).bytes;
    await asSystem(db, async (trx) => {
      const holder = await trx.insertInto('users').values({ email: `avatar-${accountId}@exemple.fr` }).returning('id').executeTakeFirstOrThrow();
      const asset = await trx
        .insertInto('media_assets')
        .values({ workspace_id: workspaceId, kind: 'upload', storage_key: `${workspaceId}/avatars/${accountId}/a.png`, mime: 'image/png', ai_generated: true })
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      await media.write(asset.storage_key, bytes);
      await trx.insertInto('account_avatars').values({ account_id: accountId, workspace_id: workspaceId, asset_id: asset.id, consent_version: 'v', consent_text: 't', consented_by: holder.id }).execute();
    });
    const ctx = await context();
    const own = await prepareVisual(deps(), ctx, await account(), { accountId, postText: POST, summary: 'S', withPhoto: true });
    expect(own?.content.photo).toBe('avatar');
    expect(own?.aiGenerated).toBe(true);
    expect(images.requests).toHaveLength(0);
    const otherAccount = (await asSystem(db, (trx) => loadAccountVisuals(trx, [other], NOW))).get(other) as AccountVisual;
    const foreign = await prepareVisual(deps(), ctx, otherAccount, { accountId: other, postText: POST, summary: 'S', withPhoto: true });
    expect(foreign?.content.photo).toBe('generated');
  });
});

/**
 * Préparation du visuel d'un post (VIS-03 à VIS-05, VIS-08, VIS-12) :
 * 1. l'IA tire du post les textes du modèle et, si le visuel porte une photo, choisit une
 *    photo de la médiathèque ou décrit une scène à générer ;
 * 2. l'image est générée si besoin, dans la limite du budget mensuel de l'espace (VIS-05)
 *    et de deux images par post (RÈG-19) ; sinon le visuel devient un visuel texte ;
 * 3. le modèle est choisi, rempli et rendu en PNG ; s'il pose un problème de lisibilité,
 *    le modèle suivant est essayé et le meilleur rendu est gardé (VIS-11) ;
 * 4. les fichiers sont écrits ; les lignes (images, lien au post, coût) sont enregistrées
 *    par `storeVisual`, dans la transaction de l'appelant.
 *
 * Les appels lents (IA, générateur d'images, rendu) se font hors de toute transaction.
 */
import { randomUUID } from 'node:crypto';
import { type LibraryPhoto, ModelError, type TextModel, type UsageRecord, type VisualFill, VISUAL_LIMITS, fillVisual, inspectImage } from '@posts-auto/ai';
import { startOfLocalMonth } from '@posts-auto/core';
import type { Tx } from '@posts-auto/db';
import { type Branding, allowanceForWorkspace, ensureGalleryTemplates, loadBranding } from '@posts-auto/services';
import {
  type CanvaFieldMap,
  type ImageGenerator,
  type RenderIssue,
  type RenderResult,
  type TemplateCandidate,
  hasZone,
  downscaleJpeg,
  type GeneratedImage,
  imageSize,
  parseTemplate,
  photoBox,
  rankTemplates,
  renderTemplate,
} from '@posts-auto/visuals';
import { sql } from 'kysely';
import { loadSettings } from '../generation/load.ts';
import { recordUsage } from '../generation/store.ts';
import type { MediaStore } from '../media/media-store.ts';

/** RÈG-19 : deux essais d'image au plus par visuel. */
export const MAX_IMAGES_PER_POST = 2;
/** Photos de la médiathèque proposées à l'IA (les plus récentes). */
const LIBRARY_LIMIT = 40;
/** Visuels récents pris en compte pour l'alternance (VIS-04). */
const HISTORY_SIZE = 8;
const HISTORY_DAYS = 90;
/** Fenêtre de la variété des modèles. */
const USES_DAYS = 60;

export interface VisualDeps {
  readonly model: TextModel;
  readonly media: MediaStore;
  /** Générateur d'images (VIS-05) ; sans lui : photo de la médiathèque ou visuel texte. */
  readonly images: ImageGenerator | null;
  /** VIS-07 : rendu par Canva des modèles de marque Canva ; sans lui, rendu local de secours. */
  readonly canva?: CanvaRenderer | null;
}

/** Rendu d'un modèle de marque Canva : copie remplie dans le Canva du client, exportée en PNG. */
export type CanvaRenderer = (input: {
  readonly workspaceId: string;
  readonly brandTemplateId: string;
  readonly fields: CanvaFieldMap;
  readonly title: string;
  readonly content: { readonly title: string; readonly subtitle: string | null; readonly bullets: readonly string[]; readonly signature: string; readonly photo: Uint8Array | null };
}) => Promise<Uint8Array>;

export interface VisualTemplate extends TemplateCandidate {
  readonly name: string;
  /** VIS-07 : modèle de marque Canva (sa définition locale sert au choix et au secours). */
  readonly canva?: { readonly brandTemplateId: string; readonly fields: CanvaFieldMap } | null;
}

interface StoredPhoto extends LibraryPhoto {
  readonly storageKey: string;
  readonly aiGenerated: boolean;
}

export interface VisualContext {
  readonly workspaceId: string;
  readonly branding: Branding;
  readonly logo: Uint8Array | null;
  readonly templates: readonly VisualTemplate[];
  readonly library: readonly StoredPhoto[];
  /** VIS-06 : avatars autorisés, par compte ; chacun ne sert qu'aux posts de son compte. */
  readonly avatars: ReadonlyMap<string, { readonly assetId: string; readonly storageKey: string }>;
  /** Images générées encore permises ce mois-ci (VIS-05), décomptées au fil de la génération. */
  imagesLeft: number;
}

export interface AccountVisual {
  readonly accountId: string;
  readonly name: string;
  /** VIS-04 : part des visuels avec photo (0 à 1). */
  readonly ratio: number;
  /** Derniers visuels du compte, du plus ancien au plus récent : avec photo ou non. */
  readonly history: readonly boolean[];
  /** Utilisation récente de chaque modèle par le compte. */
  readonly uses: ReadonlyMap<string, number>;
}

/** Charte, modèles (la galerie de départ est copiée au premier besoin), médiathèque, budget du mois. */
export async function loadVisualContext(trx: Tx, media: MediaStore, workspaceId: string, now: Date): Promise<VisualContext> {
  await ensureGalleryTemplates(trx, workspaceId);
  const branding = await loadBranding(trx, workspaceId);
  const settings = await loadSettings(trx, workspaceId);
  const workspace = await trx.selectFrom('workspaces').select('image_budget_monthly').where('id', '=', workspaceId).executeTakeFirstOrThrow();
  const used = await trx
    .selectFrom('ai_usage')
    .select(sql<number>`coalesce(sum(units), 0)::int`.as('n'))
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'image')
    .where('at', '>=', startOfLocalMonth(now, settings.calendar))
    .executeTakeFirstOrThrow();

  const imageQuota = (await allowanceForWorkspace(trx, workspaceId, now)).images.remaining;

  const rows = await trx
    .selectFrom('templates')
    .select(['id', 'account_id', 'name', 'definition', 'created_at', 'canva_brand_template_id', 'canva_fields'])
    .where('workspace_id', '=', workspaceId)
    .where('archived_at', 'is', null)
    .execute();
  const templates: VisualTemplate[] = [];
  for (const row of rows) {
    try {
      templates.push({
        id: row.id,
        accountId: row.account_id,
        name: row.name,
        definition: parseTemplate(row.definition),
        createdAt: row.created_at,
        canva: row.canva_brand_template_id === null ? null : { brandTemplateId: row.canva_brand_template_id, fields: (row.canva_fields ?? {}) as CanvaFieldMap },
      });
    } catch {
      // Définition invalide (modifiée hors de l'application) : modèle ignoré.
    }
  }

  const library = await trx
    .selectFrom('media_assets')
    .select(['id', 'label', 'folder', 'tags', 'storage_key', 'ai_generated'])
    .where('workspace_id', '=', workspaceId)
    .where('in_library', '=', true)
    .orderBy('created_at', 'desc')
    .limit(LIBRARY_LIMIT)
    .execute();

  const avatarRows = await trx
    .selectFrom('account_avatars as v')
    .innerJoin('media_assets as m', 'm.id', 'v.asset_id')
    .select(['v.account_id', 'v.asset_id', 'm.storage_key'])
    .where('v.workspace_id', '=', workspaceId)
    .where('v.revoked_at', 'is', null)
    .execute();

  let logo: Uint8Array | null = null;
  if (branding.logoAssetId !== null) {
    const asset = await trx.selectFrom('media_assets').select('storage_key').where('id', '=', branding.logoAssetId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (asset !== undefined) logo = await media.read(asset.storage_key).catch(() => null);
  }

  return {
    workspaceId,
    branding,
    logo,
    templates,
    library: library.map((p) => ({ id: p.id, label: p.label, folder: p.folder, tags: p.tags, storageKey: p.storage_key, aiGenerated: p.ai_generated })),
    avatars: new Map(avatarRows.map((a) => [a.account_id, { assetId: a.asset_id, storageKey: a.storage_key }])),
    // Budget de l'espace (VIS-05) et, pour un abonné, quota d'images de sa formule (FAC-04).
    imagesLeft: Math.min(Math.max(0, workspace.image_budget_monthly - used.n), imageQuota ?? Number.POSITIVE_INFINITY),
  };
}

/** Réglage d'alternance, derniers visuels et modèles récemment utilisés de chaque compte. */
export async function loadAccountVisuals(trx: Tx, accountIds: readonly string[], now: Date): Promise<Map<string, AccountVisual>> {
  const result = new Map<string, AccountVisual>();
  if (accountIds.length === 0) return result;
  const ids = [...new Set(accountIds)];
  const accounts = await trx
    .selectFrom('social_accounts as a')
    .leftJoin('account_profiles as p', 'p.account_id', 'a.id')
    .select(['a.id', 'a.display_name', 'p.ai_image_ratio'])
    .where('a.id', 'in', ids)
    .execute();
  const visuals = await trx
    .selectFrom('post_media as pm')
    .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
    .innerJoin('posts as p', 'p.id', 'pm.post_id')
    .select(['p.account_id', 'm.template_id', 'm.created_at', sql<string | null>`m.render_content ->> 'photo'`.as('photo')])
    .where('p.account_id', 'in', ids)
    .where('m.kind', '=', 'rendered')
    .where('m.created_at', '>=', new Date(now.getTime() - HISTORY_DAYS * 86_400_000))
    .orderBy('m.created_at')
    .execute();
  const usesSince = now.getTime() - USES_DAYS * 86_400_000;
  for (const account of accounts) {
    const own = visuals.filter((v) => v.account_id === account.id);
    const uses = new Map<string, number>();
    for (const v of own) if (v.template_id !== null && v.created_at.getTime() >= usesSince) uses.set(v.template_id, (uses.get(v.template_id) ?? 0) + 1);
    result.set(account.id, {
      accountId: account.id,
      name: account.display_name ?? 'Compte',
      ratio: account.ai_image_ratio === null ? 0.5 : Number(account.ai_image_ratio),
      history: own.slice(-HISTORY_SIZE).map((v) => v.photo !== null),
      uses,
    });
  }
  return result;
}

export interface PreviousVisual {
  readonly assetId: string;
  readonly templateId: string | null;
  readonly title: string;
  readonly bullets: readonly string[];
  readonly photo: { readonly assetId: string; readonly storageKey: string; readonly aiGenerated: boolean } | null;
}

export interface VisualRequest {
  readonly accountId: string;
  readonly postText: string;
  /** Sujet en une phrase : titre de secours si l'IA ne répond pas. */
  readonly summary: string;
  /** VIS-04 : ce visuel doit-il porter une photo ? */
  readonly withPhoto: boolean;
  /** VIS-13 : « refaire le visuel ». */
  readonly instruction?: string | null;
  readonly previous?: PreviousVisual | null;
  /**
   * La photo du visuel précédent n'est pas reprise : nouvelle photo si `withPhoto`, sinon
   * visuel sans photo. Par défaut, elle est gardée.
   */
  readonly newPhoto?: boolean;
  /** Images déjà générées pour ce post (RÈG-19). */
  readonly imagesForPost?: number;
  /**
   * IA indisponible : titre repris du sujet (rédaction, par défaut), ou erreur pour que
   * l'appelant réessaie plus tard (« refaire le visuel », où la consigne compte).
   */
  readonly fallbackOnModelError?: boolean;
}

export type PhotoSource = 'generated' | 'library' | 'kept' | 'avatar';

/** Recette d'un visuel rendu (media_assets.render_content). */
export interface RenderContent {
  readonly title: string;
  readonly subtitle: string | null;
  readonly bullets: readonly string[];
  readonly signature: string;
  readonly photo: PhotoSource | null;
  readonly imageSubject: string | null;
  readonly instruction: string | null;
  readonly issues: readonly { readonly code: string; readonly zone: string }[];
  readonly notes: readonly string[];
  readonly suspiciousInstructions: readonly string[];
}

interface GeneratedPhoto {
  readonly assetId: string;
  readonly storageKey: string;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
}

/** Une image générée, gardée ou écartée au contrôle : elle compte et coûte (RÈG-19, GEN-11). */
export interface ImageCost {
  readonly provider: string;
  readonly model: string;
  readonly costUsd: number;
}

export interface PreparedVisual {
  readonly assetId: string;
  readonly storageKey: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly templateId: string;
  /** VIS-12 : le visuel contient une image générée par IA. */
  readonly aiGenerated: boolean;
  readonly photoAssetId: string | null;
  readonly generated: GeneratedPhoto | null;
  readonly imageCosts: readonly ImageCost[];
  readonly content: RenderContent;
  readonly altText: string;
  readonly issues: readonly RenderIssue[];
  readonly calls: readonly UsageRecord[];
}

const firstWords = (text: string) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if ([...clean].length <= VISUAL_LIMITS.title) return clean;
  const cut = [...clean].slice(0, VISUAL_LIMITS.title).join('');
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trim();
};

/** Le meilleur rendu : le moins de problèmes, un texte coupé comptant plus qu'un contraste. */
const severity = (issues: readonly RenderIssue[]) => issues.reduce((n, i) => n + (i.code === 'text_truncated' ? 3 : i.code === 'low_contrast' ? 2 : 1), 0);

/**
 * Prépare le visuel ; null si l'espace n'a aucun modèle actif (il les a tous archivés).
 * Les fichiers sont écrits dans le stockage ; rien n'est encore écrit en base.
 */
export async function prepareVisual(deps: VisualDeps, ctx: VisualContext, account: AccountVisual, request: VisualRequest): Promise<PreparedVisual | null> {
  const usable = ctx.templates.filter((t) => t.accountId === null || t.accountId === account.accountId);
  if (usable.length === 0) return null;
  const notes: string[] = [];
  const keptPhoto = request.newPhoto ? null : (request.previous?.photo ?? null);
  const photoTemplatesExist = usable.some((t) => hasZone(t.definition, 'photo'));
  const choosePhoto = keptPhoto === null && request.withPhoto && photoTemplatesExist;

  // 1. Textes, et choix de la photo par l'IA.
  const calls: UsageRecord[] = [];
  let fill: VisualFill;
  try {
    const result = await fillVisual(deps.model, {
      postText: request.postText,
      accountName: account.name,
      wantPhoto: choosePhoto,
      library: ctx.library,
      instruction: request.instruction ?? null,
      previous: request.previous ? { title: request.previous.title, bullets: request.previous.bullets } : null,
    });
    fill = result.fill;
    calls.push(result.call);
  } catch (error) {
    if (!(error instanceof ModelError) || request.fallbackOnModelError === false) throw error;
    notes.push('Textes du visuel repris du sujet du post : l’IA n’a pas répondu.');
    fill = { title: firstWords(request.summary), subtitle: null, bullets: [], libraryPhotoId: null, imageSubject: null, altText: '', suspiciousInstructions: [] };
  }

  const rank = (withPhoto: boolean): VisualTemplate[] => {
    const ranked = rankTemplates(usable, { accountId: account.accountId, withPhoto, bullets: fill.bullets.length, uses: account.uses }) as VisualTemplate[];
    // « Refaire le visuel » garde le modèle précédent s'il convient encore.
    const previous = ranked.find((t) => t.id === request.previous?.templateId);
    return previous === undefined ? ranked : [previous, ...ranked.filter((t) => t !== previous)];
  };

  // 2. La photo : gardée, prise dans la médiathèque, ou générée.
  let photo: { source: PhotoSource; assetId: string; bytes: Uint8Array; aiGenerated: boolean } | null = null;
  let generated: GeneratedPhoto | null = null;
  const imageCosts: ImageCost[] = [];
  /** Ce que montre l'image générée, relevé au contrôle (texte alternatif). */
  let photoDescription: string | null = null;
  if (keptPhoto !== null) {
    const bytes = await deps.media.read(keptPhoto.storageKey).catch(() => null);
    if (bytes === null) notes.push('Photo du visuel précédent introuvable : visuel sans photo.');
    else photo = { source: 'kept', assetId: keptPhoto.assetId, bytes, aiGenerated: keptPhoto.aiGenerated };
  } else if (choosePhoto && fill.libraryPhotoId !== null) {
    const chosen = ctx.library.find((p) => p.id === fill.libraryPhotoId) as StoredPhoto;
    const bytes = await deps.media.read(chosen.storageKey).catch(() => null);
    if (bytes === null) notes.push('Photo de la médiathèque introuvable : visuel sans photo.');
    else photo = { source: 'library', assetId: chosen.id, bytes, aiGenerated: chosen.aiGenerated };
  } else if (choosePhoto && fill.imageSubject !== null && ctx.avatars.has(request.accountId)) {
    // VIS-06 : avatar autorisé du titulaire, à la place d'une image générée (posts de son compte).
    const avatar = ctx.avatars.get(request.accountId) as { assetId: string; storageKey: string };
    const bytes = await deps.media.read(avatar.storageKey).catch(() => null);
    if (bytes === null) notes.push('Avatar du titulaire introuvable : visuel sans photo.');
    else photo = { source: 'avatar', assetId: avatar.assetId, bytes, aiGenerated: true };
  } else if (choosePhoto && fill.imageSubject !== null) {
    const box = photoBox((rank(true)[0] as VisualTemplate).definition) ?? { width: 1080, height: 1080 };
    if (deps.images === null) notes.push('Aucun générateur d’images n’est configuré : visuel sans photo.');
    else {
      // VIS-11 : chaque image est contrôlée ; une image écartée est refaite une fois, en
      // précisant ce qu'il faut éviter, dans la limite de 2 images par post et du budget.
      let subject = fill.imageSubject;
      let used = request.imagesForPost ?? 0;
      while (photo === null) {
        if (used >= MAX_IMAGES_PER_POST) {
          notes.push(`Déjà ${MAX_IMAGES_PER_POST} images générées pour ce post (RÈG-19) : visuel sans nouvelle photo.`);
          break;
        }
        if (ctx.imagesLeft <= 0) {
          notes.push('Budget d’images générées du mois atteint (VIS-05) : visuel sans photo.');
          break;
        }
        // Décompté avant l'appel : les visuels préparés en parallèle voient le même budget.
        ctx.imagesLeft -= 1;
        let image: GeneratedImage;
        try {
          image = await deps.images.generate({ subject, width: box.width, height: box.height });
        } catch (error) {
          ctx.imagesLeft += 1;
          notes.push(`Image non générée (${error instanceof Error ? error.message : String(error)}) : visuel sans photo.`);
          break;
        }
        used += 1;
        // Toute image générée est comptée (RÈG-19), même écartée au contrôle.
        imageCosts.push({ provider: image.provider, model: image.model, costUsd: image.costUsd ?? 0 });
        let problems: readonly string[] = [];
        try {
          const checked = await inspectImage(deps.model, { mime: 'image/jpeg', data: await downscaleJpeg(image.bytes) });
          calls.push(checked.call);
          problems = checked.inspection.problems;
          photoDescription = checked.inspection.description || null;
        } catch (error) {
          if (!(error instanceof ModelError)) throw error;
          notes.push('Image non contrôlée (IA indisponible) : vérifiez qu’elle ne montre ni personne identifiable, ni texte, ni logo.');
        }
        if (problems.length > 0) {
          notes.push(`Image écartée au contrôle : ${problems.join(', ')}.`);
          photoDescription = null;
          subject = `${fill.imageSubject} Éviter absolument : ${problems.join(', ')}.`;
          continue;
        }
        const size = await imageSize(image.bytes);
        const assetId = randomUUID();
        const storageKey = `${ctx.workspaceId}/visuels/${assetId}.${image.mime === 'image/png' ? 'png' : 'jpg'}`;
        await deps.media.write(storageKey, image.bytes);
        generated = {
          assetId,
          storageKey,
          mime: image.mime,
          width: size.width,
          height: size.height,
          bytes: image.bytes.length,
          provider: image.provider,
          model: image.model,
          prompt: image.prompt,
        };
        photo = { source: 'generated', assetId, bytes: image.bytes, aiGenerated: true };
      }
    }
  }

  // 3. Rendu : au plus deux modèles essayés, le meilleur est gardé.
  let candidates = rank(photo !== null);
  if (candidates.length === 0) candidates = rank(photo === null);
  const content = {
    title: fill.title,
    ...(fill.subtitle !== null && { subtitle: fill.subtitle }),
    bullets: fill.bullets,
    signature: account.name,
    photo: photo?.bytes ?? null,
    logo: ctx.logo,
  };
  let best: { template: VisualTemplate; result: RenderResult } | null = null;
  for (const template of candidates.slice(0, 2)) {
    let result: RenderResult | null = null;
    if (template.canva && deps.canva) {
      try {
        const png = await deps.canva({
          workspaceId: ctx.workspaceId,
          brandTemplateId: template.canva.brandTemplateId,
          fields: template.canva.fields,
          title: `${account.name} · ${fill.title}`,
          content: { title: fill.title, subtitle: fill.subtitle, bullets: fill.bullets, signature: account.name, photo: photo?.bytes ?? null },
        });
        const size = await imageSize(png).catch(() => ({ width: 1080, height: 1080 }));
        result = { png, width: size.width, height: size.height, issues: [] };
      } catch (error) {
        notes.push(`Canva n’a pas pu préparer le visuel (${error instanceof Error ? error.message : String(error)}) : rendu local du modèle.`);
      }
    }
    result ??= await renderTemplate(template.definition, content);
    if (best === null || severity(result.issues) < severity(best.result.issues)) best = { template, result };
    if (result.issues.length === 0) break;
  }
  if (best === null) return null;

  const assetId = randomUUID();
  const storageKey = `${ctx.workspaceId}/visuels/${assetId}.png`;
  await deps.media.write(storageKey, best.result.png);
  const aiGenerated = photo?.aiGenerated ?? false;
  // Texte alternatif : ce que montre vraiment l'image générée quand le contrôle l'a décrite.
  const description = (photoDescription === null ? fill.altText || fill.title : `${fill.title.replace(/[.\s]+$/, '')}. ${photoDescription}`).replace(/[.\s]+$/, '');
  return {
    assetId,
    storageKey,
    bytes: best.result.png.length,
    width: best.result.width,
    height: best.result.height,
    templateId: best.template.id,
    aiGenerated,
    photoAssetId: photo?.assetId ?? null,
    generated,
    imageCosts,
    altText: `${description}.${aiGenerated ? ' Illustration générée par IA.' : ''}`,
    issues: best.result.issues,
    calls,
    content: {
      title: fill.title,
      subtitle: fill.subtitle,
      bullets: fill.bullets,
      signature: account.name,
      photo: photo?.source ?? null,
      imageSubject: generated === null ? null : fill.imageSubject,
      instruction: request.instruction?.trim() || null,
      issues: best.result.issues.map((i) => ({ code: i.code, zone: i.zone })),
      notes,
      suspiciousInstructions: fill.suspiciousInstructions,
    },
  };
}

export interface VisualTarget {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly postId: string;
  readonly runId: string | null;
  readonly usdToEur: number;
  /** Visuel remplacé (« refaire le visuel ») : le nouveau prend sa place. */
  readonly replacesAssetId?: string | null;
}

/**
 * Enregistre le visuel préparé, dans la transaction de l'appelant : coût de chaque image
 * générée, gardée ou écartée au contrôle (RÈG-19 : chaque image compte), image gardée,
 * visuel rendu et sa recette, place n°1 du post (ou celle du visuel remplacé), coût du
 * remplissage et du contrôle.
 */
export async function storeVisual(trx: Tx, prepared: PreparedVisual, target: VisualTarget, now: Date): Promise<number> {
  const { generated } = prepared;
  if (generated !== null) {
    await trx
      .insertInto('media_assets')
      .values({
        id: generated.assetId,
        workspace_id: target.workspaceId,
        kind: 'generated',
        ai_generated: true,
        storage_key: generated.storageKey,
        mime: generated.mime,
        width: generated.width,
        height: generated.height,
        bytes: generated.bytes,
        generator: `${generated.provider}/${generated.model}`,
        prompt: generated.prompt,
        created_at: now,
      })
      .execute();
  }
  if (prepared.imageCosts.length > 0) {
    await trx
      .insertInto('ai_usage')
      .values(
        prepared.imageCosts.map((image) => ({
          workspace_id: target.workspaceId,
          account_id: target.accountId,
          run_id: target.runId,
          post_id: target.postId,
          provider: image.provider,
          model: image.model,
          purpose: 'image' as const,
          kind: 'image' as const,
          units: 1,
          cost_usd: image.costUsd.toFixed(6),
          cost_eur: (image.costUsd * target.usdToEur).toFixed(6),
          counted_in_quota: true,
          at: now,
        })),
      )
      .execute();
  }
  await trx
    .insertInto('media_assets')
    .values({
      id: prepared.assetId,
      workspace_id: target.workspaceId,
      kind: 'rendered',
      ai_generated: prepared.aiGenerated,
      storage_key: prepared.storageKey,
      mime: 'image/png',
      width: prepared.width,
      height: prepared.height,
      bytes: prepared.bytes,
      template_id: prepared.templateId,
      source_asset_id: prepared.photoAssetId,
      render_content: JSON.stringify(prepared.content),
      created_at: now,
    })
    .execute();

  const media = await trx.selectFrom('post_media').select(['id', 'asset_id', 'position']).where('post_id', '=', target.postId).orderBy('position', 'desc').execute();
  const replaced = media.find((m) => m.asset_id === target.replacesAssetId);
  let position = 1;
  if (replaced !== undefined) {
    position = replaced.position;
    await trx.deleteFrom('post_media').where('id', '=', replaced.id).execute();
  } else {
    // Le visuel devient la couverture ; les autres images reculent d'un rang.
    for (const m of media) await trx.updateTable('post_media').set({ position: m.position + 1 }).where('id', '=', m.id).execute();
  }
  await trx
    .insertInto('post_media')
    .values({ workspace_id: target.workspaceId, post_id: target.postId, asset_id: prepared.assetId, position, alt_text: prepared.altText })
    .execute();
  const textUsd = await recordUsage(
    trx,
    { workspaceId: target.workspaceId, accountId: target.accountId, runId: target.runId, postId: target.postId, calls: prepared.calls, usdToEur: target.usdToEur, countsInQuota: false },
    now,
  );
  return textUsd + prepared.imageCosts.reduce((sum, image) => sum + image.costUsd, 0);
}

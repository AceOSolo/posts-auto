/**
 * Bibliothèque de modèles (VIS-01), éditeur (VIS-02), charte visuelle (ONB-05) et budget
 * d'images générées (VIS-05).
 *
 * Tous les membres voient les modèles ; la gestion du contenu (propriétaire, admin,
 * éditeur : matrice 3.3) les modifie. Le budget d'images engage des frais : il est réservé
 * au propriétaire et aux admins.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_WORKSPACE_CALENDAR, startOfLocalMonth } from '@posts-auto/core';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { FONT_KEYS, type FontKey, type TemplateDefinition, TemplateError, galleryTemplates, hasZone, parseTemplate } from '@posts-auto/visuals';
import { sql } from 'kysely';
import { type WorkspaceRole, canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { type ImageMime, checkImage } from '../media/image-check.ts';
import { type Branding, ensureGalleryTemplates, loadBranding } from './branding.ts';

export interface TemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly format: 'square' | 'portrait';
  readonly hasPhoto: boolean;
  readonly hasBullets: boolean;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly archived: boolean;
  readonly galleryKey: string | null;
  readonly updatedAt: Date;
}

export interface AccountChoice {
  readonly id: string;
  readonly name: string;
}

export interface TemplateLibrary {
  readonly templates: readonly TemplateSummary[];
  readonly accounts: readonly AccountChoice[];
  readonly branding: Branding;
  readonly imageBudget: { readonly monthly: number; readonly used: number };
  readonly canManage: boolean;
  /** Propriétaire ou admin : budget d'images. */
  readonly canSetBudget: boolean;
}

const canSetBudget = (role: WorkspaceRole | null) => role === 'owner' || role === 'admin';

async function requireRole(trx: Tx, userId: string, workspaceId: string): Promise<WorkspaceRole> {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

async function accountsOf(trx: Tx, workspaceId: string): Promise<AccountChoice[]> {
  const rows = await trx.selectFrom('social_accounts').select(['id', 'display_name']).where('workspace_id', '=', workspaceId).orderBy('kind', 'desc').orderBy('display_name').execute();
  return rows.map((r) => ({ id: r.id, name: r.display_name ?? 'Compte LinkedIn' }));
}

/** Images générées ce mois-ci (mois civil, fuseau de l'espace). */
async function imagesThisMonth(trx: Tx, workspaceId: string, timeZone: string, now: Date): Promise<number> {
  const row = await trx
    .selectFrom('ai_usage')
    .select(sql<number>`coalesce(sum(units), 0)::int`.as('n'))
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'image')
    .where('at', '>=', startOfLocalMonth(now, { ...DEFAULT_WORKSPACE_CALENDAR, timeZone }))
    .executeTakeFirstOrThrow();
  return row.n;
}

export async function getTemplateLibrary(db: Database, userId: string, workspaceId: string, now: Date): Promise<TemplateLibrary> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    // La galerie de départ est copiée à la première visite de qui peut gérer les modèles.
    if (canManageContent(role)) await ensureGalleryTemplates(trx, workspaceId, userId);
    const rows = await trx
      .selectFrom('templates as t')
      .leftJoin('social_accounts as a', 'a.id', 't.account_id')
      .select(['t.id', 't.name', 't.format', 't.has_photo', 't.definition', 't.account_id', 'a.display_name', 't.archived_at', 't.gallery_key', 't.updated_at'])
      .where('t.workspace_id', '=', workspaceId)
      .orderBy(sql`t.archived_at is not null`)
      .orderBy('t.created_at')
      .execute();
    const workspace = await trx.selectFrom('workspaces').select(['timezone', 'image_budget_monthly']).where('id', '=', workspaceId).executeTakeFirstOrThrow();
    return {
      templates: rows.map((r) => ({
        id: r.id,
        name: r.name,
        format: r.format as 'square' | 'portrait',
        hasPhoto: r.has_photo ?? false,
        hasBullets: ((r.definition as { zones?: { kind?: string }[] }).zones ?? []).some((z) => z.kind === 'bullets'),
        accountId: r.account_id,
        accountName: r.account_id === null ? null : (r.display_name ?? 'Compte LinkedIn'),
        archived: r.archived_at !== null,
        galleryKey: r.gallery_key,
        updatedAt: r.updated_at,
      })),
      accounts: await accountsOf(trx, workspaceId),
      branding: await loadBranding(trx, workspaceId),
      imageBudget: { monthly: workspace.image_budget_monthly, used: await imagesThisMonth(trx, workspaceId, workspace.timezone, now) },
      canManage: canManageContent(role),
      canSetBudget: canSetBudget(role),
    };
  });
}

export interface TemplateDetail {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly accountId: string | null;
  readonly definition: TemplateDefinition;
  readonly archived: boolean;
  readonly galleryKey: string | null;
  readonly canManage: boolean;
  readonly accounts: readonly AccountChoice[];
  readonly branding: Branding;
}

export async function getTemplate(db: Database, userId: string, templateId: string): Promise<TemplateDetail> {
  return asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('templates').selectAll().where('id', '=', templateId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Modèle');
    const role = await requireRole(trx, userId, row.workspace_id);
    let definition: TemplateDefinition;
    try {
      definition = parseTemplate(row.definition);
    } catch {
      definition = galleryTemplates()[0]?.definition as TemplateDefinition;
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      accountId: row.account_id,
      definition,
      archived: row.archived_at !== null,
      galleryKey: row.gallery_key,
      canManage: canManageContent(role),
      accounts: await accountsOf(trx, row.workspace_id),
      branding: await loadBranding(trx, row.workspace_id),
    };
  });
}

export interface TemplateInput {
  /** null : nouveau modèle. */
  readonly id: string | null;
  readonly name: string;
  readonly accountId: string | null;
  readonly definition: unknown;
}

/** Enregistre un modèle après validation complète de sa définition ; renvoie son identifiant. */
export async function saveTemplate(db: Database, userId: string, workspaceId: string, input: TemplateInput, now: Date): Promise<string> {
  const name = cleanText(input.name, 80);
  if (name === null) throw new RefusedError('nom_modele_requis', 'Donnez un nom au modèle.');
  let definition: TemplateDefinition;
  try {
    definition = parseTemplate(input.definition);
  } catch (error) {
    if (error instanceof TemplateError) throw new RefusedError('modele_invalide', error.message);
    throw error;
  }
  if (!definition.zones.some((z) => z.kind === 'title')) throw new RefusedError('modele_invalide', 'Un modèle a au moins une zone de titre.');
  return asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editTemplate');
    if (input.accountId !== null) {
      const account = await trx.selectFrom('social_accounts').select('id').where('id', '=', input.accountId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (account === undefined) throw new RefusedError('compte_inconnu', 'Compte inconnu dans cet espace.');
    }
    const values = { name, account_id: input.accountId, format: definition.format, definition: JSON.stringify(definition) };
    let id = input.id;
    if (id === null) {
      id = randomUUID();
      await trx.insertInto('templates').values({ id, workspace_id: workspaceId, ...values, created_by: userId, created_at: now }).execute();
    } else {
      const updated = await trx.updateTable('templates').set(values).where('id', '=', id).where('workspace_id', '=', workspaceId).returning('id').executeTakeFirst();
      if (updated === undefined) throw new NotFoundError('Modèle');
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: input.id === null ? 'modele.cree' : 'modele.modifie', entity: 'template', entityId: id, details: { name }, at: now });
    return id;
  });
}

export async function duplicateTemplate(db: Database, userId: string, templateId: string, now: Date): Promise<string> {
  const source = await getTemplate(db, userId, templateId);
  return saveTemplate(db, userId, source.workspaceId, { id: null, name: `${source.name} (copie)`.slice(0, 80), accountId: source.accountId, definition: source.definition }, now);
}

/** Un modèle n'est jamais supprimé : archivé, il n'est plus proposé à l'IA. */
export async function setTemplateArchived(db: Database, userId: string, templateId: string, archived: boolean, now: Date): Promise<string> {
  return asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('templates').select(['workspace_id', 'name']).where('id', '=', templateId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Modèle');
    if (!canManageContent(await requireRole(trx, userId, row.workspace_id))) throw new ForbiddenError('editTemplate');
    await trx.updateTable('templates').set({ archived_at: archived ? now : null }).where('id', '=', templateId).execute();
    await audit(trx, { workspaceId: row.workspace_id, actorUserId: userId, action: archived ? 'modele.archive' : 'modele.restaure', entity: 'template', entityId: templateId, details: { name: row.name }, at: now });
    return row.workspace_id;
  });
}

/** Remet les modèles de départ aux couleurs de la charte ; leurs modifications sont perdues. */
export async function recolorGalleryTemplates(db: Database, userId: string, workspaceId: string, now: Date): Promise<number> {
  return asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editTemplate');
    const gallery = new Map(galleryTemplates(await loadBranding(trx, workspaceId)).map((t) => [t.key, t]));
    const rows = await trx.selectFrom('templates').select(['id', 'gallery_key']).where('workspace_id', '=', workspaceId).where('gallery_key', 'is not', null).where('account_id', 'is', null).execute();
    let count = 0;
    for (const row of rows) {
      const model = gallery.get(row.gallery_key as string);
      if (model === undefined) continue;
      await trx.updateTable('templates').set({ definition: JSON.stringify(model.definition), format: model.definition.format, name: model.name }).where('id', '=', row.id).execute();
      count += 1;
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: 'modele.galerie_recoloree', entity: 'workspace', entityId: workspaceId, details: { count }, at: now });
    return count;
  });
}

const COLOR = /^#[0-9a-f]{6}$/i;
const EXTENSIONS: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

export interface BrandingInput {
  readonly primary: string;
  readonly secondary: string;
  readonly light: string;
  readonly dark: string;
  /** Police des titres (VIS-02) ; absente : garder l'actuelle. */
  readonly font?: FontKey;
  /** Nouveau logo ; null : retirer le logo ; absent : garder l'actuel. */
  readonly logo?: { readonly bytes: Uint8Array; readonly mime?: string } | null;
  /** Images générées par mois (propriétaire et admins seulement). */
  readonly imageBudgetMonthly?: number;
}

/** ONB-05 : couleurs et logo de la charte ; VIS-05 : budget mensuel d'images générées. */
export async function saveBranding(db: Database, media: MediaWriter, userId: string, workspaceId: string, input: BrandingInput, now: Date): Promise<void> {
  for (const key of ['primary', 'secondary', 'light', 'dark'] as const) {
    if (!COLOR.test(input[key])) throw new RefusedError('couleur_invalide', 'Couleur invalide : format #rrggbb.');
  }
  if (input.font !== undefined && !FONT_KEYS.includes(input.font)) throw new RefusedError('police_inconnue', 'Police inconnue.');
  const budget = input.imageBudgetMonthly;
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 0 || budget > 1000)) throw new RefusedError('budget_invalide', 'Budget d’images : un nombre entre 0 et 1000.');
  let logo: { bytes: Uint8Array; mime: ImageMime } | null | undefined = input.logo === undefined ? undefined : null;
  if (input.logo) {
    const checked = checkImage(input.logo.bytes, input.logo.mime);
    if (!checked.ok) throw new RefusedError(checked.code, 'Logo refusé.');
    logo = { bytes: checked.bytes, mime: checked.mime };
  }
  await asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    if (!canManageContent(role)) throw new ForbiddenError('editBranding');
    if (budget !== undefined && !canSetBudget(role)) throw new ForbiddenError('editImageBudget');
    const current = await loadBranding(trx, workspaceId);
    let logoAssetId = current.logoAssetId;
    if (logo === null) logoAssetId = null;
    if (logo) {
      logoAssetId = randomUUID();
      const storageKey = `${workspaceId}/charte/${logoAssetId}.${EXTENSIONS[logo.mime]}`;
      await media.write(storageKey, logo.bytes);
      await trx
        .insertInto('media_assets')
        .values({ id: logoAssetId, workspace_id: workspaceId, kind: 'upload', storage_key: storageKey, mime: logo.mime, bytes: logo.bytes.length, label: 'Logo', uploaded_by: userId, created_at: now })
        .execute();
    }
    const branding = {
      primary: input.primary.toLowerCase(),
      secondary: input.secondary.toLowerCase(),
      light: input.light.toLowerCase(),
      dark: input.dark.toLowerCase(),
      font: input.font ?? current.font,
      logoAssetId,
    };
    await trx
      .updateTable('workspaces')
      .set({ branding: JSON.stringify(branding), ...(budget !== undefined && { image_budget_monthly: budget }) })
      .where('id', '=', workspaceId)
      .execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'charte.modifiee', entity: 'workspace', entityId: workspaceId, details: { logo: logo === undefined ? 'inchange' : logo === null ? 'retire' : 'nouveau', budget: budget ?? null }, at: now });
  });
}

/** Zones utiles d'un modèle, pour l'afficher dans la bibliothèque. */
export function describeTemplate(definition: TemplateDefinition): string {
  const parts = [definition.format === 'square' ? 'Carré' : 'Portrait'];
  if (hasZone(definition, 'photo')) parts.push('photo');
  if (hasZone(definition, 'bullets')) parts.push('liste de points');
  if (hasZone(definition, 'logo')) parts.push('logo');
  return parts.join(' · ');
}

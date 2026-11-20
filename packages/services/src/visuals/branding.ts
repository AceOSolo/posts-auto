/**
 * Charte visuelle de l'espace (ONB-05, VIS-02) et modèles de départ (VIS-01).
 *
 * La charte (colonne workspaces.branding) : couleurs principale, d'accent, claire et
 * sombre, et logo (une image de la médiathèque de l'espace).
 */
import type { Tx } from '@posts-auto/db';
import { type Brand, parseBrand } from '@posts-auto/visuals';
import { galleryCatalog } from '../admin/gallery.ts';

export interface Branding extends Brand {
  readonly logoAssetId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseBranding(raw: unknown): Branding {
  const logo = (raw as { logoAssetId?: unknown } | null)?.logoAssetId;
  return { ...parseBrand(raw), logoAssetId: typeof logo === 'string' && UUID.test(logo) ? logo : null };
}

export async function loadBranding(trx: Tx, workspaceId: string): Promise<Branding> {
  const row = await trx.selectFrom('workspaces').select('branding').where('id', '=', workspaceId).executeTakeFirst();
  return parseBranding(row?.branding ?? null);
}

/**
 * Donne à l'espace sa copie des modèles de départ, aux couleurs de sa charte, s'il n'a
 * encore aucun modèle. Un espace qui a archivé tous ses modèles n'en reçoit pas d'autres.
 * Renvoie le nombre de modèles créés.
 */
export async function ensureGalleryTemplates(trx: Tx, workspaceId: string, createdBy: string | null = null): Promise<number> {
  const existing = await trx.selectFrom('templates').select('id').where('workspace_id', '=', workspaceId).limit(1).executeTakeFirst();
  if (existing !== undefined) return 0;
  const brand = await loadBranding(trx, workspaceId);
  const rows = (await galleryCatalog(trx, brand)).map((t) => ({
    workspace_id: workspaceId,
    name: t.name,
    format: t.definition.format,
    definition: JSON.stringify(t.definition),
    gallery_key: t.key,
    created_by: createdBy,
  }));
  // Deux appels simultanés : le second ne crée rien (copie unique par modèle de départ).
  const inserted = await trx
    .insertInto('templates')
    .values(rows)
    .onConflict((oc) => oc.columns(['workspace_id', 'gallery_key']).where('gallery_key', 'is not', null).where('account_id', 'is', null).doNothing())
    .returning('id')
    .execute();
  return inserted.length;
}

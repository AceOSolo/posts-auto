/**
 * Médiathèque des photos de l'entreprise (VIS-08) : envoi, dossier, mots-clés. L'IA peut y
 * choisir une photo réelle pertinente plutôt qu'une image générée.
 *
 * Tous les membres sauf les lecteurs ajoutent des photos (ce sont souvent eux qui les
 * prennent) ; la gestion du contenu, ou la personne qui l'a envoyée, classe ou retire une
 * photo. Retirer une photo de la médiathèque ne la retire pas des posts qui l'utilisent.
 * Mêmes contrôles que les autres images (SEC-07) : type réel, 10 Mo, métadonnées retirées.
 */
import { randomUUID } from 'node:crypto';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { imageSize } from '@posts-auto/visuals';
import { canManageContent, canPropose, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { type ImageMime, checkImage } from '../media/image-check.ts';

export const LIBRARY_MAX_UPLOAD = 20;
const EXTENSIONS: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

export interface LibraryItem {
  readonly id: string;
  readonly label: string | null;
  readonly folder: string | null;
  readonly tags: readonly string[];
  readonly width: number | null;
  readonly height: number | null;
  readonly uploadedBy: string | null;
  readonly createdAt: Date;
  /** La personne peut la classer ou la retirer. */
  readonly canEdit: boolean;
}

export interface LibraryView {
  readonly photos: readonly LibraryItem[];
  readonly folders: readonly string[];
  readonly tags: readonly string[];
  readonly canAdd: boolean;
}

/** Mots-clés saisis séparés par des virgules : minuscules, sans doublon, 10 au plus. */
export function parseTags(raw: string | readonly string[] | null | undefined): string[] {
  const list = typeof raw === 'string' ? raw.split(/[,;\n]/) : [...(raw ?? [])];
  const tags = list.map((t) => t.trim().toLocaleLowerCase('fr').replace(/\s+/g, ' ').slice(0, 30)).filter((t) => t !== '');
  return [...new Set(tags)].slice(0, 10);
}

async function requireRole(trx: Tx, userId: string, workspaceId: string) {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

export async function listLibrary(db: Database, userId: string, workspaceId: string, filter: { readonly folder?: string | null; readonly tag?: string | null } = {}): Promise<LibraryView> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    const all = await trx
      .selectFrom('media_assets as m')
      .leftJoin('users as u', 'u.id', 'm.uploaded_by')
      .select(['m.id', 'm.label', 'm.folder', 'm.tags', 'm.width', 'm.height', 'm.uploaded_by', 'u.full_name', 'm.created_at'])
      .where('m.workspace_id', '=', workspaceId)
      .where('m.in_library', '=', true)
      .orderBy('m.created_at', 'desc')
      .execute();
    const folders = [...new Set(all.map((p) => p.folder).filter((f): f is string => f !== null))].sort((a, b) => a.localeCompare(b, 'fr'));
    const tags = [...new Set(all.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b, 'fr'));
    const tag = filter.tag?.toLocaleLowerCase('fr') ?? null;
    return {
      photos: all
        .filter((p) => (filter.folder ? p.folder === filter.folder : true) && (tag ? p.tags.includes(tag) : true))
        .map((p) => ({
          id: p.id,
          label: p.label,
          folder: p.folder,
          tags: p.tags,
          width: p.width,
          height: p.height,
          uploadedBy: p.full_name,
          createdAt: p.created_at,
          canEdit: canManageContent(role) || p.uploaded_by === userId,
        })),
      folders,
      tags,
      canAdd: canPropose(role),
    };
  });
}

export interface LibraryUpload {
  readonly bytes: Uint8Array;
  readonly mime?: string;
  /** Nom de la photo (par défaut, le nom du fichier sans extension). */
  readonly label?: string | null;
}

/** Ajoute des photos à la médiathèque, avec un dossier et des mots-clés communs. */
export async function addLibraryPhotos(
  db: Database,
  media: MediaWriter,
  userId: string,
  workspaceId: string,
  photos: readonly LibraryUpload[],
  meta: { readonly folder?: string | null; readonly tags?: string | null },
  now: Date,
): Promise<number> {
  if (photos.length === 0) throw new RefusedError('aucune_photo', 'Choisissez au moins une photo.');
  if (photos.length > LIBRARY_MAX_UPLOAD) throw new RefusedError('trop_de_photos', `Au plus ${LIBRARY_MAX_UPLOAD} photos à la fois.`);
  const checked = await Promise.all(
    photos.map(async (photo, index) => {
      const result = checkImage(photo.bytes, photo.mime);
      if (!result.ok) throw new RefusedError(result.code, `Photo n°${index + 1} refusée.`);
      const size = await imageSize(result.bytes).catch(() => null);
      if (size === null) throw new RefusedError('image_corrupted', `Photo n°${index + 1} illisible.`);
      return { ...result, size, label: cleanText(photo.label, 120) };
    }),
  );
  const folder = cleanText(meta.folder, 60);
  const tags = parseTags(meta.tags);
  return asUser(db, userId, async (trx) => {
    if (!canPropose(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('addLibraryPhoto');
    for (const photo of checked) {
      const id = randomUUID();
      const storageKey = `${workspaceId}/mediatheque/${id}.${EXTENSIONS[photo.mime]}`;
      await media.write(storageKey, photo.bytes);
      await trx
        .insertInto('media_assets')
        .values({
          id,
          workspace_id: workspaceId,
          kind: 'upload',
          storage_key: storageKey,
          mime: photo.mime,
          bytes: photo.bytes.length,
          width: photo.size.width,
          height: photo.size.height,
          in_library: true,
          label: photo.label,
          folder,
          tags,
          uploaded_by: userId,
          created_at: now,
        })
        .execute();
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: 'mediatheque.photos_ajoutees', entity: 'workspace', entityId: workspaceId, details: { count: checked.length, folder }, at: now });
    return checked.length;
  });
}

async function editablePhoto(trx: Tx, userId: string, assetId: string): Promise<{ workspaceId: string }> {
  const row = await trx.selectFrom('media_assets').select(['workspace_id', 'uploaded_by']).where('id', '=', assetId).where('in_library', '=', true).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Photo');
  const role = await requireRole(trx, userId, row.workspace_id);
  if (!canManageContent(role) && row.uploaded_by !== userId) throw new ForbiddenError('editLibraryPhoto');
  return { workspaceId: row.workspace_id };
}

export async function updateLibraryPhoto(
  db: Database,
  userId: string,
  assetId: string,
  input: { readonly label?: string | null; readonly folder?: string | null; readonly tags?: string | null },
  now: Date,
): Promise<string> {
  return asUser(db, userId, async (trx) => {
    const { workspaceId } = await editablePhoto(trx, userId, assetId);
    await trx
      .updateTable('media_assets')
      .set({ label: cleanText(input.label, 120), folder: cleanText(input.folder, 60), tags: parseTags(input.tags) })
      .where('id', '=', assetId)
      .execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'mediatheque.photo_classee', entity: 'media_asset', entityId: assetId, details: {}, at: now });
    return workspaceId;
  });
}

/** Retire la photo de la médiathèque ; les posts qui l'utilisent la gardent. */
export async function removeFromLibrary(db: Database, userId: string, assetId: string, now: Date): Promise<string> {
  return asUser(db, userId, async (trx) => {
    const { workspaceId } = await editablePhoto(trx, userId, assetId);
    await trx.updateTable('media_assets').set({ in_library: false }).where('id', '=', assetId).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'mediatheque.photo_retiree', entity: 'media_asset', entityId: assetId, details: {}, at: now });
    return workspaceId;
  });
}

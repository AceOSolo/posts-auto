/**
 * Photos d'un post, gérées par le titulaire ou l'équipe (VIS-09, VIS-13, REC-11) : ajout,
 * retrait, changement d'ordre (la n°1 est la couverture).
 *
 * Mêmes droits et même règle que pour le texte (RÈG-07) : modifier les photos d'un post
 * validé quand on n'est ni titulaire ni délégué le renvoie en validation.
 * Mêmes contrôles que l'API d'échange (SEC-07) : type réel, 10 Mo, métadonnées retirées.
 */
import { randomUUID } from 'node:crypto';
import { onTextEdited } from '@posts-auto/core';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { type Access, canEditPost, loadAccess } from '../access.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { type ImageMime, checkImage } from '../media/image-check.ts';

export const MAX_PHOTOS_PER_POST = 9;
const EXTENSIONS: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

export interface UploadedPhoto {
  readonly bytes: Uint8Array;
  readonly mime?: string;
  readonly altText?: string;
}

interface EditablePost {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  readonly status: Parameters<typeof onTextEdited>[0]['status'];
}

/** Charge le post, vérifie le droit de le modifier, applique RÈG-07 si besoin (photos et visuels). */
export async function editablePost(trx: Tx, userId: string, postId: string, now: Date): Promise<{ post: EditablePost; access: Access }> {
  const post = await trx.selectFrom('posts').select(['id', 'workspace_id', 'account_id', 'status']).where('id', '=', postId).forUpdate().executeTakeFirst();
  if (post === undefined) throw new NotFoundError('Post');
  const access = await loadAccess(trx, userId, post.workspace_id, post.account_id);
  if (!canEditPost(access)) throw new ForbiddenError('editMedia');
  const edit = onTextEdited({ status: post.status, hasBlockingMarkers: false }, access.actor, now);
  if (!edit.allowed) throw new RefusedError('not_editable', 'Ce post ne peut plus être modifié ici (déjà parti ou sorti du circuit).');
  if (edit.statusChange !== null) {
    await trx.updateTable('posts').set({ status: edit.statusChange.to }).where('id', '=', post.id).execute();
    await trx
      .insertInto('post_status_history')
      .values({
        workspace_id: post.workspace_id,
        post_id: post.id,
        from_status: edit.statusChange.from,
        to_status: edit.statusChange.to,
        actor_kind: 'user',
        actor_user_id: userId,
        reason: 'Photos modifiées par une personne non déléguée : nouvelle validation nécessaire (RÈG-07)',
        at: now,
      })
      .execute();
  }
  return { post, access };
}

async function photosOf(trx: Tx, postId: string) {
  return trx.selectFrom('post_media').select(['id', 'asset_id', 'position']).where('post_id', '=', postId).orderBy('position').execute();
}

/** Renumérote les photos 1, 2, 3… dans l'ordre donné (contrainte d'unicité contrôlée en fin de transaction). */
async function renumber(trx: Tx, ids: readonly string[]): Promise<void> {
  for (const [index, id] of ids.entries()) await trx.updateTable('post_media').set({ position: index + 1 }).where('id', '=', id).execute();
}

export async function addPostPhotos(db: Database, media: MediaWriter, userId: string, postId: string, photos: readonly UploadedPhoto[], now: Date): Promise<number> {
  if (photos.length === 0) throw new RefusedError('aucune_photo', 'Choisissez au moins une photo.');
  const checked = photos.map((photo, index) => {
    const result = checkImage(photo.bytes, photo.mime);
    if (!result.ok) throw new RefusedError(result.code, `Photo n°${index + 1} refusée.`);
    return { ...photo, mime: result.mime, bytes: result.bytes };
  });

  return asUser(db, userId, async (trx) => {
    const { post } = await editablePost(trx, userId, postId, now);
    const existing = await photosOf(trx, post.id);
    if (existing.length + checked.length > MAX_PHOTOS_PER_POST) {
      throw new RefusedError('too_many_images', `Au plus ${MAX_PHOTOS_PER_POST} photos par post.`);
    }
    for (const [index, photo] of checked.entries()) {
      const position = existing.length + index + 1;
      // Le fichier porte l'identifiant de l'image : aucun risque de collision entre deux ajouts simultanés.
      const assetId = randomUUID();
      const storageKey = `${post.workspace_id}/posts/${post.id}/${assetId}.${EXTENSIONS[photo.mime]}`;
      await media.write(storageKey, photo.bytes);
      await trx
        .insertInto('media_assets')
        .values({ id: assetId, workspace_id: post.workspace_id, kind: 'upload', storage_key: storageKey, mime: photo.mime, bytes: photo.bytes.length })
        .execute();
      await trx
        .insertInto('post_media')
        .values({ workspace_id: post.workspace_id, post_id: post.id, asset_id: assetId, position, alt_text: photo.altText?.trim() || null })
        .execute();
    }
    return existing.length + checked.length;
  });
}

export async function removePostPhoto(db: Database, userId: string, postId: string, assetId: string, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    const { post } = await editablePost(trx, userId, postId, now);
    const photos = await photosOf(trx, post.id);
    const target = photos.find((photo) => photo.asset_id === assetId);
    if (target === undefined) throw new NotFoundError('Photo');
    await trx.deleteFrom('post_media').where('id', '=', target.id).execute();
    await renumber(trx, photos.filter((photo) => photo.id !== target.id).map((photo) => photo.id));
  });
}

/** Avance ou recule une photo d'un rang (flèches, sans JavaScript). */
export async function movePostPhoto(db: Database, userId: string, postId: string, assetId: string, direction: 'up' | 'down', now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    const { post } = await editablePost(trx, userId, postId, now);
    const ids = (await photosOf(trx, post.id)).map((photo) => ({ id: photo.id, assetId: photo.asset_id }));
    const index = ids.findIndex((photo) => photo.assetId === assetId);
    if (index === -1) throw new NotFoundError('Photo');
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= ids.length) return;
    [ids[index], ids[swapWith]] = [ids[swapWith] as (typeof ids)[number], ids[index] as (typeof ids)[number]];
    await renumber(trx, ids.map((photo) => photo.id));
  });
}

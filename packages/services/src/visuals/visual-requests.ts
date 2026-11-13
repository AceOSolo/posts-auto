/**
 * « Refaire le visuel » (VIS-13) : la personne donne une consigne et choisit pour la photo
 * (la garder, en changer, s'en passer) ; le worker prépare le nouveau visuel, qui prend la
 * place de l'ancien. Sur un post sans visuel, la même demande en ajoute un.
 *
 * Mêmes droits que pour modifier les photos du post (matrice 3.3) ; RÈG-07 : demander un
 * nouveau visuel pour un post validé quand on n'est ni titulaire ni délégué le renvoie en
 * validation.
 */
import { type Database, asUser } from '@posts-auto/db';
import { audit } from '../audit.ts';
import { RefusedError } from '../errors.ts';
import { MAX_PHOTOS_PER_POST, editablePost } from '../posts/post-media.ts';

export type PhotoMode = 'keep' | 'new' | 'none';
export const PHOTO_MODES: readonly PhotoMode[] = ['keep', 'new', 'none'];
/** Chaque visuel refait coûte un appel à l'IA, parfois une image : 20 par personne et par heure. */
export const VISUAL_REDO_MAX_PER_HOUR = 20;
const VISUAL_STATUSES = ['brouillon', 'a_valider', 'modif', 'valide'];

export async function requestVisualRedo(
  db: Database,
  userId: string,
  postId: string,
  input: { readonly instruction?: string | null; readonly photoMode: PhotoMode },
  now: Date,
): Promise<void> {
  if (!PHOTO_MODES.includes(input.photoMode)) throw new RefusedError('photo_mode', 'Choix de photo inconnu.');
  const instruction = input.instruction?.replace(/\s+/g, ' ').trim().slice(0, 1000) || null;
  await asUser(db, userId, async (trx) => {
    const status = await trx.selectFrom('posts').select('status').where('id', '=', postId).executeTakeFirst();
    if (status !== undefined && !VISUAL_STATUSES.includes(status.status)) {
      throw new RefusedError('not_editable', 'Le visuel de ce post ne peut plus changer (déjà parti ou sorti du circuit).');
    }
    const { post } = await editablePost(trx, userId, postId, now);

    const recent = await trx
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('actor_user_id', '=', userId)
      .where('action', '=', 'post.visuel_refait')
      .where('at', '>', new Date(now.getTime() - 3_600_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= VISUAL_REDO_MAX_PER_HOUR) throw new RefusedError('trop_de_visuels', 'Trop de visuels demandés : réessayez dans une heure.');

    // Un visuel ajouté à un post qui n'en a pas prend une place : neuf images au plus.
    const media = await trx
      .selectFrom('post_media as pm')
      .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
      .select('m.kind')
      .where('pm.post_id', '=', post.id)
      .execute();
    const hasVisual = media.some((m) => m.kind === 'rendered');
    if (!hasVisual && media.length >= MAX_PHOTOS_PER_POST) throw new RefusedError('too_many_images', `Au plus ${MAX_PHOTOS_PER_POST} images par post : retirez-en une d’abord.`);

    const task = { reason: hasVisual ? ('redo' as const) : ('new' as const), instruction, photo_mode: input.photoMode, requested_by: userId };
    await trx
      .insertInto('visual_tasks')
      .values({ post_id: post.id, workspace_id: post.workspace_id, ...task, created_at: now })
      .onConflict((oc) => oc.column('post_id').doUpdateSet({ ...task, attempts: 0, lease_until: null, failed_at: null, error: null, created_at: now }))
      .execute();
    await audit(trx, { workspaceId: post.workspace_id, actorUserId: userId, action: 'post.visuel_refait', entity: 'post', entityId: post.id, details: { photoMode: input.photoMode, instruction: instruction !== null }, at: now });
  });
}

/** État d'un visuel demandé : en préparation, ou en échec (avec l'erreur). */
export interface VisualTaskState {
  readonly status: 'pending' | 'failed';
  readonly instruction: string | null;
  readonly photoMode: PhotoMode;
  readonly error: string | null;
  readonly requestedAt: Date;
}

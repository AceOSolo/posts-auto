/**
 * Validation depuis l'e-mail (VAL-06, SEC-05, REC-14).
 *
 * - Un lien par post et par personne, à usage unique, valable jusqu'au créneau et au plus
 *   7 jours. Seule l'empreinte du jeton est stockée ; le jeton n'existe en clair que dans
 *   l'e-mail.
 * - Ouvrir le lien ne valide rien : la page montre le post et demande « Confirmer ». Les
 *   antivirus de messagerie qui ouvrent les liens ne déclenchent donc aucune validation.
 * - La validation se fait sous l'identité de la personne destinataire (droits et RLS) :
 *   si elle n'est plus titulaire ni déléguée, ou si le post a changé, le lien échoue.
 */
import { type DepartureInput, departureSentence } from '@posts-auto/core';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { loadAccess } from '../access.ts';
import { hashToken, newToken } from '../auth/auth.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { decidePost } from './post-actions.ts';
import { type PostMedia, mediaOfPost } from './post-queries.ts';

export const APPROVAL_LINK_MAX_DAYS = 7;

/** Crée un lien « Valider » ; renvoie le jeton en clair, à ne mettre que dans l'e-mail. */
export async function createApprovalLink(db: Database, postId: string, userId: string, now: Date): Promise<string> {
  const token = newToken();
  await asSystem(db, async (trx) => {
    const post = await trx.selectFrom('posts').select(['workspace_id', 'scheduled_at']).where('id', '=', postId).executeTakeFirstOrThrow();
    const maxEnd = now.getTime() + APPROVAL_LINK_MAX_DAYS * 86_400_000;
    const expiresAt = new Date(Math.min(post.scheduled_at.getTime(), maxEnd));
    await trx
      .insertInto('approval_links')
      .values({ token_hash: hashToken(token), workspace_id: post.workspace_id, post_id: postId, user_id: userId, action: 'validate', expires_at: expiresAt, created_at: now })
      .execute();
  });
  return token;
}

export interface ApprovalPreview {
  readonly postId: string;
  readonly accountName: string;
  readonly accountKind: 'profile' | 'page';
  readonly body: string;
  /** Les visuels partent avec le post : ils se relisent avant de valider. */
  readonly media: readonly PostMedia[];
  readonly departure: string;
  readonly hasBlockingMarkers: boolean;
  /** Le post attend encore une décision (sinon le lien n'a plus d'objet). */
  readonly pending: boolean;
}

async function loadLink(db: Database, token: string, now: Date) {
  if (token.length < 20 || token.length > 100) return null;
  return asSystem(db, async (trx) => {
    const link = await trx
      .selectFrom('approval_links as l')
      .innerJoin('posts as p', 'p.id', 'l.post_id')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
      .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select([
        'l.token_hash',
        'l.post_id',
        'l.user_id',
        'l.expires_at',
        'l.used_at',
        'p.workspace_id',
        'p.account_id',
        'p.status',
        'p.scheduled_at',
        'p.original_scheduled_at',
        'p.reschedule_count',
        'a.display_name',
        'a.kind as account_kind',
        'w.timezone',
        'v.body',
        'v.has_blocking_markers',
      ])
      .where('l.token_hash', '=', hashToken(token))
      .where('l.action', '=', 'validate')
      .executeTakeFirst();
    if (link === undefined || link.used_at !== null || link.expires_at.getTime() <= now.getTime()) return null;
    return link;
  });
}

/** Le destinataire est-il toujours titulaire ou délégué ? Sinon le lien ne montre plus rien. */
async function stillDecides(db: Database, link: { readonly user_id: string; readonly workspace_id: string; readonly account_id: string }): Promise<boolean> {
  const access = await asUser(db, link.user_id, (trx) => loadAccess(trx, link.user_id, link.workspace_id, link.account_id));
  return access.relation !== 'none';
}

/** Page ouverte depuis l'e-mail : montre le post, ne consomme rien. */
export async function previewApprovalLink(db: Database, token: string, now: Date): Promise<ApprovalPreview | null> {
  const link = await loadLink(db, token, now);
  if (link === null || !(await stillDecides(db, link))) return null;
  const media = await asSystem(db, (trx) => mediaOfPost(trx, link.post_id));
  const departure: DepartureInput = {
    status: link.status,
    scheduledAt: link.scheduled_at,
    originalScheduledAt: link.original_scheduled_at,
    rescheduleCount: link.reschedule_count,
  };
  return {
    postId: link.post_id,
    accountName: link.display_name ?? 'Compte LinkedIn',
    accountKind: link.account_kind as 'profile' | 'page',
    body: link.body ?? '',
    media,
    departure: departureSentence(departure, now, link.timezone),
    hasBlockingMarkers: link.has_blocking_markers ?? true,
    pending: link.status === 'a_valider',
  };
}

/** Image d'un post, pour la page ouverte depuis l'e-mail : seulement celles de ce post, tant que le lien vit. */
export async function approvalLinkMedia(db: Database, token: string, assetId: string, now: Date): Promise<{ storageKey: string; mime: string } | null> {
  const link = await loadLink(db, token, now);
  if (link === null || !(await stillDecides(db, link))) return null;
  const row = await asSystem(db, (trx) =>
    trx
      .selectFrom('post_media as pm')
      .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
      .select(['m.storage_key', 'm.mime'])
      .where('pm.post_id', '=', link.post_id)
      .where('pm.asset_id', '=', assetId)
      .executeTakeFirst(),
  );
  return row === undefined ? null : { storageKey: row.storage_key, mime: row.mime };
}

export type ApprovalOutcome =
  | { readonly ok: true; readonly departsNow: boolean; readonly scheduledAt: Date }
  | { readonly ok: false; readonly reason: 'lien_invalide' | 'deja_traite' | 'a_completer' | 'plus_autorise' | 'refuse'; readonly code?: string };

/** Clic sur « Confirmer la validation » : consomme le lien et valide sous l'identité du destinataire. */
export async function confirmApprovalLink(db: Database, token: string, now: Date): Promise<ApprovalOutcome> {
  const link = await loadLink(db, token, now);
  if (link === null) return { ok: false, reason: 'lien_invalide' };
  // Usage unique, même en cas de double clic : la première consommation gagne.
  const consumed = await asSystem(db, (trx) =>
    trx.updateTable('approval_links').set({ used_at: now }).where('token_hash', '=', link.token_hash).where('used_at', 'is', null).executeTakeFirst(),
  );
  if (consumed.numUpdatedRows !== 1n) return { ok: false, reason: 'lien_invalide' };
  if (link.status !== 'a_valider') return { ok: false, reason: 'deja_traite' };
  if (link.has_blocking_markers !== false) return { ok: false, reason: 'a_completer' };

  try {
    const outcome = await decidePost(db, link.user_id, link.post_id, { type: 'validate' }, now);
    await asSystem(db, (trx) => trx.updateTable('approval_links').set({ used_at: now }).where('post_id', '=', link.post_id).where('used_at', 'is', null).execute());
    return { ok: true, departsNow: outcome.departsNow, scheduledAt: outcome.scheduledAt };
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return { ok: false, reason: 'plus_autorise' };
    if (error instanceof RefusedError) return { ok: false, reason: 'refuse', code: error.code };
    throw error;
  }
}

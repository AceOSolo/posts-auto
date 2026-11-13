/**
 * API d'échange (PUB-10) : permet à un outil externe — la tâche Claude actuelle de Secutop
 * pendant l'incrément 1a — de lire les comptes et les posts avec leurs décisions, et de
 * déposer des posts « à valider » ou des reprises.
 *
 * Contexte système, mais TOUTES les requêtes sont filtrées par l'espace de la clé : une clé
 * ne voit ni n'écrit jamais rien d'un autre espace (tests à l'appui).
 * Mêmes règles que l'application : créneaux (RÈG-03, PUB-06), transitions (6.1), limites
 * LinkedIn, contrôle des images (SEC-07).
 */
import {
  POST_ORIGINS,
  type PostOrigin,
  type PostStatus,
  SLOT_OCCUPYING_STATUSES,
  addMinutes,
  applyPostCommand,
  hasBlockingMarkers,
  slotConflicts,
} from '@posts-auto/core';
import { type Database, type Tx, asSystem, calendarOf, slotRulesOf, weekStartOf } from '@posts-auto/db';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { type ImageMime, checkImage } from '../media/image-check.ts';
import { type ApiKeyContext, type ApiScope, lockReference } from './api-keys.ts';

/** Ce dont le service a besoin du stockage des médias. */
export interface MediaWriter {
  write(storageKey: string, bytes: Uint8Array): Promise<void>;
}


const REFERENCE = /^[\w.:-]{1,100}$/;
const MAX_TEXT = 3000;
const MAX_IMAGES = 9;
/** Comme un créneau choisi à la main (RÈG-04) : au moins 15 minutes d'avance. */
const MIN_LEAD_MINUTES = 15;
/** GEN-07 : 3 reprises au plus, soit une version 4 au maximum. */
const MAX_VERSION = 4;

function requireScope(ctx: ApiKeyContext, scope: ApiScope): void {
  if (!ctx.scopes.has(scope)) throw new ForbiddenError(scope);
}

export interface ExchangeAccount {
  readonly id: string;
  readonly type: 'profil' | 'page';
  readonly nom: string | null;
  readonly statut: string;
  readonly titulaire: string | null;
}

export async function listAccounts(db: Database, ctx: ApiKeyContext): Promise<ExchangeAccount[]> {
  requireScope(ctx, 'posts:read');
  return asSystem(db, async (trx) => {
    const rows = await trx
      .selectFrom('social_accounts as a')
      .leftJoin('users as u', 'u.id', 'a.holder_user_id')
      .select(['a.id', 'a.kind', 'a.display_name', 'a.status', 'u.full_name'])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.status', '<>', 'revoked')
      .orderBy('a.display_name')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      type: row.kind === 'page' ? 'page' : 'profil',
      nom: row.display_name,
      statut: row.status,
      titulaire: row.full_name,
    }));
  });
}

export interface ExchangePost {
  readonly reference: string | null;
  readonly id: string;
  readonly compte: string;
  readonly statut: PostStatus;
  readonly creneau: string;
  readonly creneau_initial: string | null;
  readonly replanifications: number;
  readonly version: number;
  readonly remplace: string | null;
  readonly texte: string;
  readonly marqueurs_bloquants: boolean;
  /** Décision du titulaire ou de son délégué, avec sa note (modification) ou son motif (refus). */
  readonly decision: { readonly par: string | null; readonly le: string; readonly delegation: boolean; readonly note: string | null } | null;
  readonly publie_le: string | null;
  readonly lien: string | null;
  readonly erreur: string | null;
}

function postsQuery(trx: Tx, workspaceId: string) {
  return trx
    .selectFrom('posts as p')
    .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
    .leftJoin('users as d', 'd.id', 'p.decided_by')
    .leftJoin('posts as r', 'r.id', 'p.replaces_post_id')
    .select([
      'p.id',
      'p.external_ref',
      'p.account_id',
      'p.status',
      'p.scheduled_at',
      'p.original_scheduled_at',
      'p.reschedule_count',
      'p.version_no',
      'r.external_ref as replaces_ref',
      'v.body',
      'v.has_blocking_markers',
      'd.full_name as decided_by_name',
      'p.decided_at',
      'p.decided_as_delegate',
      'p.decision_note',
      'p.published_at',
      'p.external_post_url',
      'p.last_error',
    ])
    .where('p.workspace_id', '=', workspaceId);
}

type PostRow = Awaited<ReturnType<ReturnType<typeof postsQuery>['execute']>>[number];

function toExchangePost(row: PostRow): ExchangePost {
  return {
    reference: row.external_ref,
    id: row.id,
    compte: row.account_id,
    statut: row.status,
    creneau: row.scheduled_at.toISOString(),
    creneau_initial: row.original_scheduled_at?.toISOString() ?? null,
    replanifications: row.reschedule_count,
    version: row.version_no,
    remplace: row.replaces_ref,
    texte: row.body ?? '',
    marqueurs_bloquants: row.has_blocking_markers ?? false,
    decision:
      row.decided_at === null
        ? null
        : { par: row.decided_by_name, le: row.decided_at.toISOString(), delegation: row.decided_as_delegate ?? false, note: row.decision_note },
    publie_le: row.published_at?.toISOString() ?? null,
    lien: row.external_post_url,
    erreur: row.last_error,
  };
}

/** Posts de l'espace dont le créneau tombe dans [from, to] (fenêtre glissante de 2 semaines, GEN-01). */
export async function listPosts(db: Database, ctx: ApiKeyContext, window: { from: Date; to: Date }): Promise<ExchangePost[]> {
  requireScope(ctx, 'posts:read');
  if (window.to.getTime() - window.from.getTime() > 62 * 24 * 3_600_000) {
    throw new RefusedError('window_too_large', 'La période demandée dépasse 62 jours.');
  }
  return asSystem(db, async (trx) => {
    const rows = await postsQuery(trx, ctx.workspaceId)
      .where('p.scheduled_at', '>=', window.from)
      .where('p.scheduled_at', '<=', window.to)
      .orderBy('p.scheduled_at')
      .execute();
    return rows.map(toExchangePost);
  });
}

export async function getPostByReference(db: Database, ctx: ApiKeyContext, reference: string): Promise<ExchangePost> {
  requireScope(ctx, 'posts:read');
  return asSystem(db, async (trx) => {
    const row = await postsQuery(trx, ctx.workspaceId).where('p.external_ref', '=', reference).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Post');
    return toExchangePost(row);
  });
}

export interface SubmittedImage {
  readonly bytes: Uint8Array;
  readonly mime?: string;
  readonly altText?: string;
  readonly aiGenerated?: boolean;
}

export interface SubmitPostInput {
  /** Référence de l'outil externe : rend l'envoi idempotent (REC-13). */
  readonly reference: string;
  readonly accountId: string;
  readonly scheduledAt: Date;
  readonly text: string;
  readonly origin: PostOrigin;
  readonly sourceNote?: string;
  /** RÈG-11 : date limite d'un post lié à un événement. */
  readonly mustPublishBy?: Date;
  /** Référence du post remplacé : reprise (GEN-07) ou meilleur sujet (GEN-03). */
  readonly replaces?: string;
  readonly images?: readonly SubmittedImage[];
}

const EXTENSIONS: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

export async function submitPost(
  db: Database,
  ctx: ApiKeyContext,
  media: MediaWriter,
  input: SubmitPostInput,
  now: Date,
): Promise<{ created: boolean; post: ExchangePost }> {
  requireScope(ctx, 'posts:write');

  // Contrôles qui ne demandent pas la base.
  if (!REFERENCE.test(input.reference)) throw new RefusedError('invalid_reference', 'Référence invalide (1 à 100 caractères : lettres, chiffres, _ . : -).');
  if (input.text.trim().length === 0) throw new RefusedError('empty_body', 'Le texte est vide.');
  if (input.text.length > MAX_TEXT) throw new RefusedError('body_too_long', `Le texte dépasse ${MAX_TEXT} caractères.`);
  if (!(POST_ORIGINS as readonly string[]).includes(input.origin)) throw new RefusedError('invalid_origin', 'Origine inconnue.');
  if ((input.images?.length ?? 0) > MAX_IMAGES) throw new RefusedError('too_many_images', `Au plus ${MAX_IMAGES} images par post.`);
  const images = (input.images ?? []).map((image, index) => {
    const check = checkImage(image.bytes, image.mime);
    if (!check.ok) throw new RefusedError(check.code, `Image n°${index + 1} refusée (${check.code}).`);
    return { ...image, mime: check.mime, bytes: check.bytes };
  });

  const outcome = await asSystem(db, async (trx) => {
    await lockReference(trx, ctx.workspaceId, 'post', input.reference);
    const existing = await postsQuery(trx, ctx.workspaceId).where('p.external_ref', '=', input.reference).executeTakeFirst();
    if (existing !== undefined) return { created: false as const, postId: existing.id };

    const account = await trx
      .selectFrom('social_accounts')
      .select(['id', 'status'])
      .where('id', '=', input.accountId)
      .where('workspace_id', '=', ctx.workspaceId)
      .executeTakeFirst();
    if (account === undefined || account.status === 'revoked') throw new RefusedError('unknown_account', 'Compte inconnu dans cet espace.');
    if (input.scheduledAt.getTime() < addMinutes(now, MIN_LEAD_MINUTES).getTime()) {
      throw new RefusedError('too_soon', 'Le créneau doit être à au moins 15 minutes d’ici.');
    }
    if (input.mustPublishBy !== undefined && input.scheduledAt.getTime() > input.mustPublishBy.getTime()) {
      throw new RefusedError('after_event', 'Le créneau tombe après la date limite.');
    }

    // Post remplacé (reprise ou meilleur sujet) : même espace, même compte, encore remplaçable.
    let replaced: { id: string; status: PostStatus; version_no: number } | undefined;
    if (input.replaces !== undefined) {
      replaced = await trx
        .selectFrom('posts')
        .select(['id', 'status', 'version_no', 'account_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('external_ref', '=', input.replaces)
        .forUpdate()
        .executeTakeFirst()
        .then((row) => {
          if (row === undefined) throw new RefusedError('unknown_replaced', 'Post remplacé introuvable.');
          if (row.account_id !== input.accountId) throw new RefusedError('replaced_other_account', 'Le post remplacé est sur un autre compte.');
          return row;
        });
    }
    const isRework = replaced !== undefined && (replaced.status === 'modif' || replaced.status === 'refuse');
    const versionNo = isRework && replaced ? replaced.version_no + 1 : 1;
    if (versionNo > MAX_VERSION) throw new RefusedError('too_many_reworks', '3 reprises au plus : ce post passe en traitement manuel (GEN-07).');

    if (replaced !== undefined) {
      const result = applyPostCommand({ status: replaced.status, hasBlockingMarkers: false }, { type: 'replace' }, { kind: 'system' }, now);
      if (!result.ok) throw new RefusedError('not_replaceable', 'Ce post ne peut plus être remplacé (déjà validé, publié ou sorti du circuit).');
      await trx.updateTable('posts').set({ status: result.status }).where('id', '=', replaced.id).execute();
      await trx
        .insertInto('post_status_history')
        .values({ workspace_id: ctx.workspaceId, post_id: replaced.id, from_status: replaced.status, to_status: 'remplace', actor_kind: 'system', reason: `Remplacé par ${input.reference} (API d’échange)`, at: now })
        .execute();
    }

    // Créneau libre (RÈG-03, PUB-06), le post remplacé n'occupant plus le sien.
    const ws = await trx
      .selectFrom('workspaces')
      .select(['timezone', 'allowed_hours', 'holidays_calendar', 'slot_step_minutes', 'max_posts_per_account_per_day', 'min_gap_minutes', 'max_posts_per_slot'])
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    const calendar = calendarOf(ws);
    const occupied = await trx
      .selectFrom('posts')
      .select(['id as postId', 'account_id as accountId', 'scheduled_at as at'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', 'in', [...SLOT_OCCUPYING_STATUSES])
      .where('scheduled_at', '>=', addMinutes(input.scheduledAt, -24 * 60))
      .where('scheduled_at', '<=', addMinutes(input.scheduledAt, 24 * 60))
      .execute();
    const conflicts = slotConflicts(input.scheduledAt, input.accountId, { calendar, rules: slotRulesOf(ws), occupied });
    if (conflicts.length > 0) throw new RefusedError(conflicts[0] as string, 'Ce créneau est déjà pris ou trop proche d’un autre post de l’espace.');

    const post = await trx
      .insertInto('posts')
      .values({
        workspace_id: ctx.workspaceId,
        account_id: input.accountId,
        week_start: weekStartOf(input.scheduledAt, calendar),
        scheduled_at: input.scheduledAt,
        status: 'a_valider',
        origin: input.origin,
        external_ref: input.reference,
        source_note: input.sourceNote ?? null,
        must_publish_by: input.mustPublishBy ?? null,
        replaces_post_id: replaced?.id ?? null,
        version_no: versionNo,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'external_ref']).where('external_ref', 'is not', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    // Envoi simultané de la même référence : l'autre requête a gagné, on renvoie son post.
    if (post === undefined) {
      const winner = await postsQuery(trx, ctx.workspaceId).where('p.external_ref', '=', input.reference).executeTakeFirstOrThrow();
      return { created: false as const, postId: winner.id };
    }

    const version = await trx
      .insertInto('post_versions')
      .values({ workspace_id: ctx.workspaceId, post_id: post.id, revision: 1, body: input.text, author_kind: 'ai' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.updateTable('posts').set({ current_version_id: version.id }).where('id', '=', post.id).execute();
    await trx
      .insertInto('post_status_history')
      .values({
        workspace_id: ctx.workspaceId,
        post_id: post.id,
        from_status: null,
        to_status: 'a_valider',
        actor_kind: 'system',
        reason: hasBlockingMarkers(input.text) ? 'Reçu par l’API d’échange (passages à compléter)' : 'Reçu par l’API d’échange',
        at: now,
      })
      .execute();

    for (const [index, image] of images.entries()) {
      const storageKey = `${ctx.workspaceId}/posts/${post.id}/${index + 1}.${EXTENSIONS[image.mime]}`;
      await media.write(storageKey, image.bytes);
      const asset = await trx
        .insertInto('media_assets')
        .values({
          workspace_id: ctx.workspaceId,
          kind: image.aiGenerated ? 'generated' : 'upload',
          ai_generated: image.aiGenerated ?? false,
          storage_key: storageKey,
          mime: image.mime,
          bytes: image.bytes.length,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('post_media')
        .values({ workspace_id: ctx.workspaceId, post_id: post.id, asset_id: asset.id, position: index + 1, alt_text: image.altText ?? null })
        .execute();
    }

    await trx
      .insertInto('audit_log')
      .values({
        org_id: ctx.orgId,
        workspace_id: ctx.workspaceId,
        actor_kind: 'api_key',
        action: 'post.recu_api',
        entity: 'post',
        entity_id: post.id,
        details: JSON.stringify({ keyId: ctx.keyId, reference: input.reference, replaces: input.replaces ?? null }),
        at: now,
      })
      .execute();
    return { created: true as const, postId: post.id };
  });

  const post = await asSystem(db, (trx) => postsQuery(trx, ctx.workspaceId).where('p.id', '=', outcome.postId).executeTakeFirstOrThrow());
  return { created: outcome.created, post: toExchangePost(post) };
}

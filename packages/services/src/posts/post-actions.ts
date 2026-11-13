/**
 * Actions d'une personne sur un post (section 5.9 : VAL-02, VAL-03, VAL-08, PUB-04).
 *
 * Chaque action :
 * 1. charge le post sous l'identité de la personne (RLS) : invisible = introuvable ;
 * 2. calcule ses droits (titulaire, délégué, rôle) ;
 * 3. applique la règle du moteur (@posts-auto/core) ;
 * 4. enregistre statut, décision, historique et journal d'audit dans la même transaction.
 */
import {
  type PostCommand,
  type PostStatus,
  type RefusalReason,
  SLOT_OCCUPYING_STATUSES,
  type SlotContext,
  addMinutes,
  applyPostCommand,
  checkManualSlot,
  departureForValidatedPost,
  hasBlockingMarkers,
  onTextEdited,
} from '@posts-auto/core';
import { type DB, type Database, type Tx, asUser, calendarOf, slotRulesOf, weekStartOf } from '@posts-auto/db';
import type { Updateable } from 'kysely';
import { type Access, canEditPost, canReschedulePost, loadAccess } from '../access.js';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.js';

const MAX_BODY_LENGTH = 3000;

interface LoadedPost {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  readonly status: PostStatus;
  readonly scheduled_at: Date;
  readonly must_publish_by: Date | null;
  readonly has_blocking_markers: boolean;
}

async function loadPost(trx: Tx, postId: string): Promise<LoadedPost> {
  const post = await trx
    .selectFrom('posts as p')
    .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
    .select([
      'p.id',
      'p.workspace_id',
      'p.account_id',
      'p.status',
      'p.scheduled_at',
      'p.must_publish_by',
      'v.has_blocking_markers',
    ])
    .where('p.id', '=', postId)
    .forUpdate('p')
    .executeTakeFirst();
  if (post === undefined) throw new NotFoundError('Post');
  return { ...post, has_blocking_markers: post.has_blocking_markers ?? true };
}

async function slotContext(trx: Tx, workspaceId: string, now: Date): Promise<SlotContext> {
  const ws = await trx
    .selectFrom('workspaces')
    .select([
      'timezone',
      'allowed_hours',
      'holidays_calendar',
      'slot_step_minutes',
      'max_posts_per_account_per_day',
      'min_gap_minutes',
      'max_posts_per_slot',
    ])
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  const occupied = await trx
    .selectFrom('posts')
    .select(['id as postId', 'account_id as accountId', 'scheduled_at as at'])
    .where('workspace_id', '=', workspaceId)
    .where('status', 'in', [...SLOT_OCCUPYING_STATUSES])
    .where('scheduled_at', '>=', addMinutes(now, -24 * 60))
    .where('scheduled_at', '<=', addMinutes(now, 35 * 24 * 60))
    .execute();
  return { calendar: calendarOf(ws), rules: slotRulesOf(ws), occupied };
}

async function audit(trx: Tx, access: Access, workspaceId: string, action: string, postId: string, details: Record<string, unknown>, at: Date) {
  const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
  await trx
    .insertInto('audit_log')
    .values({
      org_id: ws.org_id,
      workspace_id: workspaceId,
      actor_user_id: access.userId,
      actor_kind: 'user',
      action,
      entity: 'post',
      entity_id: postId,
      details: JSON.stringify(details),
      at,
    })
    .execute();
}

async function applyAndRecord(
  trx: Tx,
  post: LoadedPost,
  access: Access,
  command: PostCommand,
  at: Date,
  extra: Updateable<DB['posts']> = {},
): Promise<PostStatus> {
  const result = applyPostCommand({ status: post.status, hasBlockingMarkers: post.has_blocking_markers }, command, access.actor, at);
  if (!result.ok) {
    if (result.error === 'actor_not_allowed') throw new ForbiddenError(command.type);
    throw new RefusedError(result.error, refusalMessage(result.error));
  }
  const decision = result.decision
    ? {
        decided_by: result.decision.decidedBy,
        decided_at: result.decision.decidedAt,
        decided_as_delegate: result.decision.asDelegate,
        decision_note: result.decision.note,
      }
    : {};
  await trx
    .updateTable('posts')
    .set({ ...extra, ...decision, status: result.status })
    .where('id', '=', post.id)
    .execute();
  await trx
    .insertInto('post_status_history')
    .values({
      workspace_id: post.workspace_id,
      post_id: post.id,
      from_status: result.change.from,
      to_status: result.change.to,
      actor_kind: 'user',
      actor_user_id: access.userId,
      reason: result.change.reason,
      at,
    })
    .execute();
  return result.status;
}

function refusalMessage(code: string): string {
  switch (code) {
    case 'blocking_markers':
      return 'Le texte contient encore [À COMPLÉTER] ou [À VÉRIFIER] : complétez-le avant de valider.';
    case 'note_required':
      return 'Indiquez ce qu’il faut modifier.';
    case 'details_required':
      return 'Précisez le motif du refus.';
    case 'transition_not_allowed':
      return 'Cette action n’est plus possible pour ce post (son statut a changé).';
    default:
      return 'Action impossible.';
  }
}

export type Decision =
  | { readonly type: 'validate' }
  | { readonly type: 'requestChanges'; readonly note: string }
  | { readonly type: 'refuse'; readonly reason: RefusalReason; readonly details?: string };

export interface DecisionOutcome {
  readonly status: PostStatus;
  /** Créneau de départ après la décision (peut avoir changé : RÈG-06). */
  readonly scheduledAt: Date;
  /** Départ immédiat (validation après le créneau, RÈG-06). */
  readonly departsNow: boolean;
}

/** VAL-02 : valider, demander une modification ou refuser. */
export async function decidePost(db: Database, userId: string, postId: string, decision: Decision, now: Date): Promise<DecisionOutcome> {
  return asUser(db, userId, async (trx) => {
    const post = await loadPost(trx, postId);
    const access = await loadAccess(trx, userId, post.workspace_id, post.account_id);
    const status = await applyAndRecord(trx, post, access, decision, now);
    await audit(trx, access, post.workspace_id, `post.${decision.type}`, post.id, { asDelegate: access.relation === 'delegate' }, now);

    if (decision.type !== 'validate' || post.scheduled_at.getTime() > now.getTime()) {
      return { status, scheduledAt: post.scheduled_at, departsNow: false };
    }

    // RÈG-06 : validé après son créneau.
    const context = await slotContext(trx, post.workspace_id, now);
    const departure = departureForValidatedPost(
      {
        postId: post.id,
        accountId: post.account_id,
        scheduledAt: post.scheduled_at,
        ...(post.must_publish_by === null ? {} : { mustPublishBy: post.must_publish_by }),
      },
      now,
      context,
    );
    if (departure.kind === 'abandon') {
      throw new RefusedError(
        departure.reason,
        departure.reason === 'evenement_passe'
          ? 'L’événement annoncé par ce post est passé : il ne peut plus être publié.'
          : 'Aucun créneau libre n’a été trouvé pour ce post.',
      );
    }
    const at = departure.at;
    await trx
      .updateTable('posts')
      .set({ scheduled_at: at, week_start: weekStartOf(at, context.calendar) })
      .where('id', '=', post.id)
      .execute();
    return { status, scheduledAt: at, departsNow: departure.kind === 'depart_now' };
  });
}

export interface TextEditOutcome {
  readonly revision: number;
  readonly status: PostStatus;
  readonly hasBlockingMarkers: boolean;
}

/** Correction du texte (révision) ; RÈG-07 pour un post déjà validé. */
export async function editPostText(db: Database, userId: string, postId: string, body: string, now: Date): Promise<TextEditOutcome> {
  if (body.trim().length === 0) throw new RefusedError('empty_body', 'Le texte ne peut pas être vide.');
  if (body.length > MAX_BODY_LENGTH) throw new RefusedError('body_too_long', `Le texte dépasse ${MAX_BODY_LENGTH} caractères (limite LinkedIn).`);

  return asUser(db, userId, async (trx) => {
    const post = await loadPost(trx, postId);
    const access = await loadAccess(trx, userId, post.workspace_id, post.account_id);
    if (!canEditPost(access)) throw new ForbiddenError('editText');

    const edit = onTextEdited({ status: post.status, hasBlockingMarkers: post.has_blocking_markers }, access.actor, now);
    if (!edit.allowed) throw new RefusedError('not_editable', 'Ce post ne peut plus être corrigé ici (déjà parti ou sorti du circuit).');

    const last = await trx.selectFrom('post_versions').select((eb) => eb.fn.max('revision').as('revision')).where('post_id', '=', post.id).executeTakeFirst();
    const revision = (last?.revision ?? 0) + 1;
    const version = await trx
      .insertInto('post_versions')
      .values({ workspace_id: post.workspace_id, post_id: post.id, revision, body, author_kind: 'user', author_user_id: userId })
      .returning('id')
      .executeTakeFirstOrThrow();

    let status = post.status;
    await trx.updateTable('posts').set({ current_version_id: version.id }).where('id', '=', post.id).execute();
    if (edit.statusChange !== null) {
      status = edit.statusChange.to;
      await trx.updateTable('posts').set({ status }).where('id', '=', post.id).execute();
      await trx
        .insertInto('post_status_history')
        .values({
          workspace_id: post.workspace_id,
          post_id: post.id,
          from_status: edit.statusChange.from,
          to_status: edit.statusChange.to,
          actor_kind: 'user',
          actor_user_id: userId,
          reason: edit.statusChange.reason,
          at: now,
        })
        .execute();
    }
    await audit(trx, access, post.workspace_id, 'post.texte_corrige', post.id, { revision }, now);
    return { revision, status, hasBlockingMarkers: hasBlockingMarkers(body) };
  });
}

export interface RescheduleOutcome {
  readonly scheduledAt: Date;
  /** Créneau hors des plages autorisées de l'espace : l'interface le signale (RÈG-04). */
  readonly outsideAllowedHours: boolean;
}

const RESCHEDULABLE: ReadonlySet<PostStatus> = new Set<PostStatus>(['a_valider', 'valide']);

/** VAL-02 « changer la date et l'heure » (RÈG-04) ; ne compte pas comme une replanification. */
export async function reschedulePost(db: Database, userId: string, postId: string, at: Date, now: Date): Promise<RescheduleOutcome> {
  return asUser(db, userId, async (trx) => {
    const post = await loadPost(trx, postId);
    const access = await loadAccess(trx, userId, post.workspace_id, post.account_id);
    if (!canReschedulePost(access)) throw new ForbiddenError('reschedule');
    if (!RESCHEDULABLE.has(post.status)) throw new RefusedError('not_reschedulable', 'Le créneau de ce post ne peut plus être changé.');
    if (post.must_publish_by !== null && at.getTime() > post.must_publish_by.getTime()) {
      throw new RefusedError('after_event', 'Ce créneau tombe après l’événement annoncé par le post.');
    }

    const context = await slotContext(trx, post.workspace_id, now);
    const check = checkManualSlot(at, post.account_id, now, context, post.id);
    if (!check.ok) {
      const code = check.errors[0] ?? 'slot_conflict';
      throw new RefusedError(code, code === 'too_soon' ? 'Choisissez un créneau à au moins 15 minutes d’ici.' : 'Ce créneau est déjà pris ou trop proche d’un autre post.');
    }
    await trx
      .updateTable('posts')
      .set({ scheduled_at: at, week_start: weekStartOf(at, context.calendar) })
      .where('id', '=', post.id)
      .execute();
    await trx
      .insertInto('post_status_history')
      .values({
        workspace_id: post.workspace_id,
        post_id: post.id,
        from_status: post.status,
        to_status: post.status,
        actor_kind: 'user',
        actor_user_id: userId,
        reason: `Créneau changé à la main : ${post.scheduled_at.toISOString()} → ${at.toISOString()}`,
        at: now,
      })
      .execute();
    await audit(trx, access, post.workspace_id, 'post.replanifie_main', post.id, { from: post.scheduled_at, to: at }, now);
    return { scheduledAt: at, outsideAllowedHours: check.outsideAllowedHours };
  });
}

/** VAL-08 : retirer un post validé tant qu'il n'est pas parti. */
export async function withdrawPost(db: Database, userId: string, postId: string, now: Date): Promise<PostStatus> {
  return asUser(db, userId, async (trx) => {
    const post = await loadPost(trx, postId);
    const access = await loadAccess(trx, userId, post.workspace_id, post.account_id);
    const status = await applyAndRecord(trx, post, access, { type: 'withdraw', reason: 'Retiré par une personne' }, now);
    await audit(trx, access, post.workspace_id, 'post.retire', post.id, {}, now);
    return status;
  });
}

/** PUB-04 : bouton « réessayer » après une erreur de publication. */
export async function retryPublication(db: Database, userId: string, postId: string, now: Date): Promise<PostStatus> {
  return asUser(db, userId, async (trx) => {
    const post = await loadPost(trx, postId);
    const access = await loadAccess(trx, userId, post.workspace_id, post.account_id);
    const status = await applyAndRecord(trx, post, access, { type: 'retry' }, now, {
      publish_retries_left: 3,
      next_publish_attempt_at: now,
      publish_lease_until: null,
    });
    await audit(trx, access, post.workspace_id, 'post.reessai', post.id, {}, now);
    return status;
  });
}

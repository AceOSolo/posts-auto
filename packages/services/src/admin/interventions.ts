/**
 * Interventions de l'éditeur depuis le back-office (décision 0008) : prolonger un essai,
 * suspendre ou réactiver une organisation, relancer une publication ou une rédaction en échec.
 *
 * - Chaque intervention est inscrite au journal d'audit du client (acteur « support »).
 * - Aucune ne lit ni n'affiche le contenu des posts.
 * - Une publication à l'issue incertaine n'est jamais relancée d'ici : le post existe peut-être
 *   déjà sur LinkedIn, et seul le client peut le vérifier (PUB-03).
 */
import { type Actor, type PostStatus, applyPostCommand } from '@posts-auto/core';
import { type Database, type Tx, asSystem } from '@posts-auto/db';
import { sql } from 'kysely';
import { allowanceForWorkspace } from '../billing/allowance.ts';
import { NotFoundError, RefusedError } from '../errors.ts';
import { requirePlatformAdmin } from './platform.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const TRIAL_EXTENSION_MAX_DAYS = 60;
/** Une fin d'essai ne peut pas être repoussée au-delà de cet horizon. */
export const TRIAL_HORIZON_DAYS = 90;
/** Au-delà, un post en erreur n'est plus d'actualité : c'est au client de décider. */
export const SUPPORT_RETRY_WINDOW_HOURS = 48;
const FAILED_GENERATION_WINDOW_DAYS = 14;
const LIST_LIMIT = 30;

interface AdminAuditEntry {
  readonly orgId: string;
  readonly workspaceId: string | null;
  readonly adminId: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly details: Record<string, unknown>;
  readonly at: Date;
}

async function adminAudit(trx: Tx, entry: AdminAuditEntry): Promise<void> {
  const admin = await trx.selectFrom('users').select('email').where('id', '=', entry.adminId).executeTakeFirstOrThrow();
  await trx
    .insertInto('audit_log')
    .values({
      org_id: entry.orgId,
      workspace_id: entry.workspaceId,
      actor_user_id: entry.adminId,
      actor_kind: 'support',
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId,
      details: JSON.stringify({ ...entry.details, by: admin.email }),
      at: entry.at,
    })
    .execute();
}

// ---------------------------------------------------------------------------
// Essai
// ---------------------------------------------------------------------------

/** Repousse la fin de l'essai. Les limites de l'essai (posts, comptes) ne changent pas. */
export async function extendTrial(db: Database, adminId: string, orgId: string, days: number, now: Date): Promise<Date> {
  await requirePlatformAdmin(db, adminId);
  if (!Number.isInteger(days) || days < 1 || days > TRIAL_EXTENSION_MAX_DAYS) throw new RefusedError('duree_essai_invalide', `Durée : de 1 à ${TRIAL_EXTENSION_MAX_DAYS} jours.`);
  return asSystem(db, async (trx) => {
    const org = await trx.selectFrom('organizations').select('trial_ends_at').where('id', '=', orgId).forUpdate().executeTakeFirst();
    if (org === undefined) throw new NotFoundError('Organisation');
    const sub = await trx.selectFrom('subscriptions').select('status').where('org_id', '=', orgId).executeTakeFirst();
    // Un abonnement, même résilié, ne redonne pas l'essai (allowanceForWorkspace).
    if (org.trial_ends_at === null || (sub !== undefined && sub.status !== 'incomplete')) throw new RefusedError('essai_non_prolongeable', 'Cette organisation n’est pas en essai.');
    const endsAt = new Date(Math.max(now.getTime(), org.trial_ends_at.getTime()) + days * DAY);
    if (endsAt.getTime() > now.getTime() + TRIAL_HORIZON_DAYS * DAY) throw new RefusedError('essai_trop_long', `La fin de l’essai ne peut pas dépasser ${TRIAL_HORIZON_DAYS} jours à partir d’aujourd’hui.`);
    await trx.updateTable('organizations').set({ trial_ends_at: endsAt }).where('id', '=', orgId).execute();
    await adminAudit(trx, { orgId, workspaceId: null, adminId, action: 'support.essai_prolonge', entity: 'organization', entityId: orgId, details: { days, from: org.trial_ends_at.toISOString(), to: endsAt.toISOString() }, at: now });
    return endsAt;
  });
}

// ---------------------------------------------------------------------------
// Suspension
// ---------------------------------------------------------------------------

export interface OrgSuspension {
  readonly reason: string;
  readonly suspendedAt: Date;
  readonly suspendedBy: string | null;
}

export async function activeSuspension(trx: Tx, orgId: string): Promise<OrgSuspension | null> {
  const row = await trx
    .selectFrom('org_suspensions as s')
    .leftJoin('users as u', 'u.id', 's.suspended_by')
    .select(['s.reason', 's.suspended_at', 'u.email'])
    .where('s.org_id', '=', orgId)
    .where('s.lifted_at', 'is', null)
    .executeTakeFirst();
  return row === undefined ? null : { reason: row.reason, suspendedAt: row.suspended_at, suspendedBy: row.email };
}

/**
 * Arrête la rédaction et la publication, sans toucher à l'abonnement ni aux données.
 * Le motif reste interne à l'éditeur : il n'est pas copié dans le journal du client.
 */
export async function suspendOrganization(db: Database, adminId: string, orgId: string, reason: string, now: Date): Promise<void> {
  await requirePlatformAdmin(db, adminId);
  const text = reason.trim();
  if (text.length < 3 || text.length > 500) throw new RefusedError('motif_suspension_requis', 'Indiquez le motif de la suspension (3 à 500 caractères).');
  await asSystem(db, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).forUpdate().executeTakeFirst();
    if (org === undefined) throw new NotFoundError('Organisation');
    if ((await activeSuspension(trx, orgId)) !== null) throw new RefusedError('organisation_deja_suspendue', 'Cette organisation est déjà suspendue.');
    await trx.insertInto('org_suspensions').values({ org_id: orgId, reason: text, suspended_by: adminId, suspended_at: now }).execute();
    await adminAudit(trx, { orgId, workspaceId: null, adminId, action: 'support.organisation_suspendue', entity: 'organization', entityId: orgId, details: {}, at: now });
  });
}

/** Lève la suspension de l'éditeur. Un impayé en cours continue de s'appliquer. */
export async function reactivateOrganization(db: Database, adminId: string, orgId: string, now: Date): Promise<void> {
  await requirePlatformAdmin(db, adminId);
  await asSystem(db, async (trx) => {
    const lifted = await trx.updateTable('org_suspensions').set({ lifted_at: now, lifted_by: adminId }).where('org_id', '=', orgId).where('lifted_at', 'is', null).returning('id').executeTakeFirst();
    if (lifted === undefined) throw new RefusedError('organisation_non_suspendue', 'Cette organisation n’est pas suspendue.');
    await adminAudit(trx, { orgId, workspaceId: null, adminId, action: 'support.organisation_reactivee', entity: 'organization', entityId: orgId, details: {}, at: now });
  });
}

// ---------------------------------------------------------------------------
// Publications en erreur
// ---------------------------------------------------------------------------

export type PublicationRetryBlock =
  | 'organisation_suspendue'
  | 'publication_bloquee_paiement'
  | 'espace_en_pause'
  | 'publication_incertaine'
  | 'compte_non_connecte'
  | 'compte_en_manuel'
  | 'evenement_passe'
  | 'marqueur_present'
  | 'publication_trop_ancienne';

const RETRY_BLOCK_TEXT: Record<PublicationRetryBlock, string> = {
  organisation_suspendue: 'Organisation suspendue.',
  publication_bloquee_paiement: 'Publication arrêtée par un impayé.',
  espace_en_pause: 'Espace en pause.',
  publication_incertaine: 'Issue incertaine : le post existe peut-être sur LinkedIn, le client doit vérifier.',
  compte_non_connecte: 'Compte LinkedIn à reconnecter par le client.',
  compte_en_manuel: 'Compte en publication manuelle.',
  evenement_passe: 'L’événement du post est passé.',
  marqueur_present: 'Le texte contient un marqueur à compléter.',
  publication_trop_ancienne: `Créneau passé depuis plus de ${SUPPORT_RETRY_WINDOW_HOURS} heures : au client de décider.`,
};

function errorPosts(trx: Tx) {
  return trx
    .selectFrom('posts as p')
    .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
    .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
    .innerJoin('organizations as o', 'o.id', 'w.org_id')
    .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
    .select([
      'p.id',
      'p.workspace_id',
      'p.scheduled_at',
      'p.must_publish_by',
      'p.last_error',
      'v.has_blocking_markers',
      'a.status as account_status',
      'a.publish_mode',
      'a.display_name',
      'w.org_id',
      'w.name as workspace_name',
      'w.status as workspace_status',
      'o.name as org_name',
      'o.status as org_status',
      sql<string | null>`(select t.outcome from publish_attempts t where t.post_id = p.id order by t.attempt desc limit 1)`.as('last_outcome'),
      sql<boolean>`exists (select 1 from org_suspensions s where s.org_id = w.org_id and s.lifted_at is null)`.as('suspended'),
    ])
    .where('p.status', '=', 'erreur');
}

interface RetryFacts {
  readonly suspended: boolean;
  readonly org_status: string;
  readonly workspace_status: string;
  readonly last_outcome: string | null;
  readonly publish_mode: string;
  readonly account_status: string;
  readonly must_publish_by: Date | null;
  readonly has_blocking_markers: boolean | null;
  readonly scheduled_at: Date;
}

function retryBlock(post: RetryFacts, canPublish: boolean, now: Date): PublicationRetryBlock | null {
  if (post.suspended) return 'organisation_suspendue';
  if (!canPublish || (post.org_status !== 'active' && post.org_status !== 'past_due')) return 'publication_bloquee_paiement';
  if (post.workspace_status !== 'active') return 'espace_en_pause';
  // Seul un échec certain peut être rejoué : sinon, risque de doublon sur LinkedIn.
  if (post.last_outcome !== 'not_created') return 'publication_incertaine';
  if (post.publish_mode === 'manual') return 'compte_en_manuel';
  if (post.publish_mode === 'auto' && post.account_status !== 'connected' && post.account_status !== 'expiring') return 'compte_non_connecte';
  if (post.account_status === 'paused' || post.account_status === 'revoked') return 'compte_non_connecte';
  if (post.must_publish_by !== null && post.must_publish_by.getTime() < now.getTime()) return 'evenement_passe';
  if (post.has_blocking_markers !== false) return 'marqueur_present';
  if (now.getTime() - post.scheduled_at.getTime() > SUPPORT_RETRY_WINDOW_HOURS * HOUR) return 'publication_trop_ancienne';
  return null;
}

export interface PublicationInError {
  readonly postId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly workspaceName: string;
  readonly accountName: string;
  readonly scheduledAt: Date;
  readonly error: string | null;
  /** Pourquoi le support ne peut pas relancer ; null : la relance est possible. */
  readonly blockedBy: string | null;
}

export async function listPublicationsInError(db: Database, adminId: string, now: Date): Promise<PublicationInError[]> {
  await requirePlatformAdmin(db, adminId);
  return asSystem(db, async (trx) => {
    const rows = await errorPosts(trx).orderBy('p.scheduled_at', 'desc').limit(LIST_LIMIT).execute();
    const canPublish = new Map<string, boolean>();
    const result: PublicationInError[] = [];
    for (const row of rows) {
      if (!canPublish.has(row.workspace_id)) canPublish.set(row.workspace_id, (await allowanceForWorkspace(trx, row.workspace_id, now)).canPublish);
      const block = retryBlock(row, canPublish.get(row.workspace_id) === true, now);
      result.push({
        postId: row.id,
        orgId: row.org_id,
        orgName: row.org_name,
        workspaceName: row.workspace_name,
        accountName: row.display_name ?? 'Compte',
        scheduledAt: row.scheduled_at,
        error: row.last_error,
        blockedBy: block === null ? null : RETRY_BLOCK_TEXT[block],
      });
    }
    return result;
  });
}

/** Relance un post dont l'échec est certain ; la file de publication le reprend à la minute. */
export async function retryPublicationAsSupport(db: Database, adminId: string, postId: string, now: Date): Promise<void> {
  await requirePlatformAdmin(db, adminId);
  await asSystem(db, async (trx) => {
    const post = await errorPosts(trx).where('p.id', '=', postId).forUpdate('p').executeTakeFirst();
    if (post === undefined) throw new RefusedError('publication_plus_en_erreur', 'Ce post n’est plus en erreur.');
    const allowance = await allowanceForWorkspace(trx, post.workspace_id, now);
    const block = retryBlock(post, allowance.canPublish, now);
    if (block !== null) throw new RefusedError(block, RETRY_BLOCK_TEXT[block]);
    const actor: Actor = { kind: 'user', userId: adminId, accountRelation: 'none', isWorkspaceManager: true };
    const from: PostStatus = 'erreur';
    const result = applyPostCommand({ status: from, hasBlockingMarkers: false }, { type: 'retry' }, actor, now);
    if (!result.ok) throw new RefusedError('publication_plus_en_erreur', 'Ce post n’est plus en erreur.');
    await trx
      .updateTable('posts')
      .set({ status: result.status, publish_retries_left: 3, next_publish_attempt_at: now, publish_lease_until: null })
      .where('id', '=', post.id)
      .execute();
    await trx
      .insertInto('post_status_history')
      .values({ workspace_id: post.workspace_id, post_id: post.id, from_status: from, to_status: result.status, actor_kind: 'user', actor_user_id: adminId, reason: 'Relance par le support de l’éditeur', at: now })
      .execute();
    await adminAudit(trx, { orgId: post.org_id, workspaceId: post.workspace_id, adminId, action: 'support.publication_relancee', entity: 'post', entityId: post.id, details: {}, at: now });
  });
}

// ---------------------------------------------------------------------------
// Rédactions en échec
// ---------------------------------------------------------------------------

export type GenerationRelaunchBlock = 'organisation_suspendue' | 'espace_en_pause' | 'redaction_en_cours' | 'rien_a_relancer' | 'redaction_deja_demandee' | 'quota_redaction_atteint';

const RELAUNCH_BLOCK_TEXT: Record<GenerationRelaunchBlock, string> = {
  organisation_suspendue: 'Organisation suspendue.',
  espace_en_pause: 'Espace en pause.',
  redaction_en_cours: 'Une rédaction est déjà en cours.',
  rien_a_relancer: 'La dernière rédaction n’est pas en échec.',
  redaction_deja_demandee: 'Une nouvelle rédaction est déjà demandée.',
  quota_redaction_atteint: 'Plus de rédaction possible : essai, quota ou paiement.',
};

async function relaunchBlock(
  trx: Tx,
  workspace: { readonly id: string; readonly status: string; readonly generation_requested_at: Date | null },
  last: { readonly status: string; readonly started_at: Date } | undefined,
  now: Date,
): Promise<GenerationRelaunchBlock | null> {
  const allowance = await allowanceForWorkspace(trx, workspace.id, now);
  if (allowance.mode === 'editor_suspended') return 'organisation_suspendue';
  if (workspace.status !== 'active') return 'espace_en_pause';
  if (last?.status === 'running') return 'redaction_en_cours';
  if (last?.status !== 'failed') return 'rien_a_relancer';
  if (workspace.generation_requested_at !== null && workspace.generation_requested_at.getTime() > last.started_at.getTime()) return 'redaction_deja_demandee';
  if (allowance.posts.remaining === 0) return 'quota_redaction_atteint';
  return null;
}

export interface FailedGeneration {
  readonly workspaceId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly workspaceName: string;
  readonly failedAt: Date;
  readonly error: string | null;
  readonly blockedBy: string | null;
}

/** Espaces dont la dernière rédaction hebdomadaire a échoué. */
export async function listFailedGenerations(db: Database, adminId: string, now: Date): Promise<FailedGeneration[]> {
  await requirePlatformAdmin(db, adminId);
  const since = now.getTime() - FAILED_GENERATION_WINDOW_DAYS * DAY;
  return asSystem(db, async (trx) => {
    const latest = await trx
      .selectFrom('generation_runs')
      .distinctOn('workspace_id')
      .select(['workspace_id', 'status', 'started_at', 'error'])
      .where('kind', '=', 'weekly')
      .orderBy('workspace_id')
      .orderBy('started_at', 'desc')
      .execute();
    const failed = latest
      .filter((r) => r.status === 'failed' && r.started_at.getTime() >= since)
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
      .slice(0, LIST_LIMIT);
    const result: FailedGeneration[] = [];
    for (const run of failed) {
      const workspace = await trx
        .selectFrom('workspaces as w')
        .innerJoin('organizations as o', 'o.id', 'w.org_id')
        .select(['w.id', 'w.name', 'w.status', 'w.generation_requested_at', 'o.id as org_id', 'o.name as org_name'])
        .where('w.id', '=', run.workspace_id)
        .executeTakeFirstOrThrow();
      const block = await relaunchBlock(trx, workspace, run, now);
      result.push({
        workspaceId: workspace.id,
        orgId: workspace.org_id,
        orgName: workspace.org_name,
        workspaceName: workspace.name,
        failedAt: run.started_at,
        error: run.error,
        blockedBy: block === null ? null : RELAUNCH_BLOCK_TEXT[block],
      });
    }
    return result;
  });
}

/** Redemande la rédaction : la tâche de fond la prend dans les 5 minutes. */
export async function relaunchGeneration(db: Database, adminId: string, workspaceId: string, now: Date): Promise<void> {
  await requirePlatformAdmin(db, adminId);
  await asSystem(db, async (trx) => {
    const workspace = await trx.selectFrom('workspaces').select(['id', 'org_id', 'status', 'generation_requested_at']).where('id', '=', workspaceId).forUpdate().executeTakeFirst();
    if (workspace === undefined) throw new NotFoundError('Espace');
    const last = await trx
      .selectFrom('generation_runs')
      .select(['status', 'started_at'])
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'weekly')
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const block = await relaunchBlock(trx, workspace, last, now);
    if (block !== null) throw new RefusedError(block, RELAUNCH_BLOCK_TEXT[block]);
    await trx.updateTable('workspaces').set({ generation_requested_at: now }).where('id', '=', workspaceId).execute();
    await adminAudit(trx, { orgId: workspace.org_id, workspaceId, adminId, action: 'support.redaction_relancee', entity: 'workspace', entityId: workspaceId, details: {}, at: now });
  });
}

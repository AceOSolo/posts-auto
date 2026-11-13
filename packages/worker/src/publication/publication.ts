/**
 * File de publication (cahier des charges, PUB-01 à PUB-05, RÈG-05, RÈG-06, RÈG-11, RÈG-22).
 *
 * Exécutée toutes les minutes (section 8.4). Chaque passage :
 * 1. reprend les envois interrompus (verrou expiré) : issue incertaine → erreur ;
 * 2. démarre les posts validés dont l'heure est atteinte, si les conditions de départ
 *    sont réunies ;
 * 3. traite les tentatives dues, une par post, sous verrou.
 *
 * Garantie d'unicité (PUB-03) : un post n'est réservé que par un processus à la fois
 * (verrou de ligne + verrou à durée limitée) ; une tentative est enregistrée AVANT l'appel
 * à LinkedIn ; une tentative à l'issue incertaine n'est jamais rejouée automatiquement.
 */
import {
  type Actor,
  type PostCommand,
  type PostStatus,
  SLOT_OCCUPYING_STATUSES,
  addMinutes,
  applyPostCommand,
  departureForValidatedPost,
} from '@posts-auto/core';
import { type DB, type Database, type Tx, asSystem, calendarOf, slotRulesOf, weekStartOf } from '@posts-auto/db';
import type { Updateable } from 'kysely';
import {
  type LinkedInImageMime,
  type LinkedInPublisher,
  type PublishImage,
  LinkedInError,
  describeForUser,
} from '@posts-auto/linkedin';
import type { MediaStore } from '../media/media-store.js';
import type { TokenCipher } from '../secrets/token-cipher.js';

/** PUB-04 : 3 nouvelles tentatives, à 1, 5 puis 15 minutes. */
export const RETRY_DELAYS_MINUTES = [1, 5, 15] as const;
/** Au-delà de ce retard, un post validé suit RÈG-06 (départ immédiat ou nouveau créneau). */
export const LATE_GRACE_MINUTES = 15;
/**
 * Durée du verrou d'envoi. Elle couvre le pire cas : 9 images (2 appels chacune) et la
 * création du post, à 30 s de délai maximal par appel, soit 9 min 30 s.
 */
export const DEFAULT_LEASE_MINUTES = 15;
const START_BATCH = 50;
const ATTEMPTS_PER_TICK = 20;

const SYSTEM: Actor = { kind: 'system' };

export interface PublicationDeps {
  readonly db: Database;
  readonly linkedin: LinkedInPublisher;
  readonly media: MediaStore;
  readonly cipher: TokenCipher;
  readonly clock?: () => Date;
  readonly leaseMinutes?: number;
}

export interface PublicationReport {
  /** Posts passés en cours d'envoi. */
  readonly started: string[];
  readonly published: string[];
  /** Échec sans danger, nouvel essai programmé. */
  readonly retryScheduled: string[];
  /** Échec définitif : statut « erreur ». */
  readonly failed: string[];
  /** Issue incertaine : statut « erreur », vérification humaine. */
  readonly uncertain: string[];
  /** Repassés « à valider » (marqueur bloquant réapparu). */
  readonly withdrawn: string[];
  /** Validés trop tard : nouveau créneau (RÈG-06). */
  readonly moved: string[];
  readonly abandoned: string[];
}

function emptyReport(): PublicationReport {
  return { started: [], published: [], retryScheduled: [], failed: [], uncertain: [], withdrawn: [], moved: [], abandoned: [] };
}

export async function runPublicationTick(deps: PublicationDeps): Promise<PublicationReport> {
  const clock = deps.clock ?? (() => new Date());
  const report = emptyReport();
  await recoverInterruptedSends(deps, clock(), report);
  await startDuePosts(deps, clock(), report);
  for (let i = 0; i < ATTEMPTS_PER_TICK; i += 1) {
    const processed = await processNextAttempt(deps, clock, report);
    if (!processed) break;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Transitions et effets communs
// ---------------------------------------------------------------------------

interface PostRef {
  readonly id: string;
  readonly workspace_id: string;
  readonly status: PostStatus;
}

/** Applique une commande du cycle de vie, met à jour le post et écrit l'historique. */
async function transition(
  trx: Tx,
  post: PostRef,
  command: PostCommand,
  at: Date,
  extra: Updateable<DB['posts']> = {},
  hasBlockingMarkers = false,
): Promise<void> {
  const result = applyPostCommand({ status: post.status, hasBlockingMarkers }, command, SYSTEM, at);
  if (!result.ok) throw new Error(`Transition refusée (${command.type} depuis ${post.status}) : ${result.error}`);
  const updated = await trx
    .updateTable('posts')
    .set({ ...extra, status: result.status })
    .where('id', '=', post.id)
    .where('status', '=', post.status)
    .executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) throw new Error(`Le post ${post.id} a changé de statut pendant la transition`);
  await trx
    .insertInto('post_status_history')
    .values({
      workspace_id: post.workspace_id,
      post_id: post.id,
      from_status: result.change.from,
      to_status: result.change.to,
      actor_kind: 'system',
      reason: result.change.reason,
      at,
    })
    .execute();
}

async function audit(trx: Tx, workspaceId: string, action: string, postId: string, details: Record<string, unknown>, at: Date) {
  const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
  await trx
    .insertInto('audit_log')
    .values({ org_id: ws.org_id, workspace_id: workspaceId, actor_kind: 'system', action, entity: 'post', entity_id: postId, details: JSON.stringify(details), at })
    .execute();
}

/** Titulaire du compte, administrateurs de l'espace, propriétaires de l'organisation. */
async function alertRecipients(trx: Tx, workspaceId: string, accountId: string): Promise<string[]> {
  const holder = await trx.selectFrom('social_accounts').select('holder_user_id').where('id', '=', accountId).executeTakeFirst();
  const admins = await trx
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('role', '=', 'admin')
    .execute();
  const owners = await trx
    .selectFrom('org_members as o')
    .innerJoin('workspaces as w', 'w.org_id', 'o.org_id')
    .select('o.user_id')
    .where('w.id', '=', workspaceId)
    .where('o.role', '=', 'owner')
    .execute();
  const ids = [holder?.holder_user_id, ...admins.map((r) => r.user_id), ...owners.map((r) => r.user_id)];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

async function notify(
  trx: Tx,
  userIds: readonly string[],
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown>,
  channels: readonly ('email' | 'in_app')[],
) {
  const rows = userIds.flatMap((userId) =>
    channels.map((channel) => ({ user_id: userId, workspace_id: workspaceId, kind, channel, payload: JSON.stringify(payload) })),
  );
  if (rows.length > 0) await trx.insertInto('notifications').values(rows).execute();
}

// ---------------------------------------------------------------------------
// 1. Envois interrompus
// ---------------------------------------------------------------------------

const INTERRUPTED_MESSAGE =
  'Publication incertaine : l’envoi a été interrompu avant la réponse de LinkedIn. Vérifiez sur LinkedIn avant de réessayer, pour éviter un doublon.';

async function recoverInterruptedSends(deps: PublicationDeps, now: Date, report: PublicationReport) {
  await asSystem(deps.db, async (trx) => {
    const stale = await trx
      .selectFrom('posts')
      .select(['id', 'workspace_id', 'account_id', 'status'])
      .where('status', '=', 'en_publication')
      .where('publish_lease_until', '<', now)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const post of stale) {
      const running = await trx
        .updateTable('publish_attempts')
        .set({ finished_at: now, outcome: 'unknown', error_message: 'Interruption pendant l’envoi' })
        .where('post_id', '=', post.id)
        .where('finished_at', 'is', null)
        .executeTakeFirst();
      if (running.numUpdatedRows === 0n) {
        // Verrou expiré sans tentative en cours : rien n'est parti, on remet le post en file.
        await trx.updateTable('posts').set({ publish_lease_until: null, next_publish_attempt_at: now }).where('id', '=', post.id).execute();
        continue;
      }
      await transition(trx, post, { type: 'markFailed', message: INTERRUPTED_MESSAGE }, now, {
        publish_lease_until: null,
        next_publish_attempt_at: null,
        last_error: INTERRUPTED_MESSAGE,
      });
      const recipients = await alertRecipients(trx, post.workspace_id, post.account_id);
      await notify(trx, recipients, post.workspace_id, 'publication_erreur', { postId: post.id, message: INTERRUPTED_MESSAGE, uncertain: true }, ['email', 'in_app']);
      await audit(trx, post.workspace_id, 'post.publication_incertaine', post.id, { cause: 'interruption' }, now);
      report.uncertain.push(post.id);
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Démarrage des posts dus
// ---------------------------------------------------------------------------

const BLOCKING_MARKER_REASON = 'Marqueur [À COMPLÉTER] ou [À VÉRIFIER] présent : nouvelle validation nécessaire (RÈG-05)';

async function startDuePosts(deps: PublicationDeps, now: Date, report: PublicationReport) {
  await asSystem(deps.db, async (trx) => {
    const due = await trx
      .selectFrom('posts as p')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select([
        'p.id',
        'p.workspace_id',
        'p.account_id',
        'p.status',
        'p.scheduled_at',
        'p.must_publish_by',
        'v.has_blocking_markers',
        'a.status as account_status',
        'w.status as workspace_status',
        'o.status as org_status',
        'w.timezone',
        'w.allowed_hours',
        'w.holidays_calendar',
        'w.slot_step_minutes',
        'w.max_posts_per_account_per_day',
        'w.min_gap_minutes',
        'w.max_posts_per_slot',
      ])
      .where('p.status', '=', 'valide')
      .where('p.scheduled_at', '<=', now)
      .orderBy('p.scheduled_at')
      .limit(START_BATCH)
      .forUpdate('p')
      .skipLocked()
      .execute();

    for (const post of due) {
      // Abonnement suspendu (FAC-06), espace en pause, compte non connecté (RÈG-22) :
      // le post reste validé et partira quand la situation sera rétablie.
      if (post.workspace_status !== 'active') continue;
      if (post.org_status !== 'active' && post.org_status !== 'past_due') continue;
      if (post.account_status !== 'connected' && post.account_status !== 'expiring') continue;

      // RÈG-11 : jamais après l'événement.
      if (post.must_publish_by !== null && post.must_publish_by.getTime() < now.getTime()) {
        await transition(trx, post, { type: 'abandon', reason: 'evenement_passe' }, now);
        report.abandoned.push(post.id);
        continue;
      }

      // RÈG-05 : un marqueur bloquant (réapparu après une correction) renvoie en validation.
      if (post.has_blocking_markers !== false) {
        await transition(trx, post, { type: 'withdraw', reason: BLOCKING_MARKER_REASON }, now);
        report.withdrawn.push(post.id);
        continue;
      }

      // RÈG-06 / RÈG-22 : très en retard (compte reconnecté, validation tardive, panne) ?
      if (now.getTime() - post.scheduled_at.getTime() > LATE_GRACE_MINUTES * 60_000) {
        const calendar = calendarOf(post);
        const occupied = await trx
          .selectFrom('posts')
          .select(['id as postId', 'account_id as accountId', 'scheduled_at as at'])
          .where('workspace_id', '=', post.workspace_id)
          .where('status', 'in', [...SLOT_OCCUPYING_STATUSES])
          .where('scheduled_at', '>=', addMinutes(now, -24 * 60))
          .where('scheduled_at', '<=', addMinutes(now, 35 * 24 * 60))
          .execute();
        const decision = departureForValidatedPost(
          {
            postId: post.id,
            accountId: post.account_id,
            scheduledAt: post.scheduled_at,
            ...(post.must_publish_by === null ? {} : { mustPublishBy: post.must_publish_by }),
          },
          now,
          { calendar, rules: slotRulesOf(post), occupied },
        );
        if (decision.kind === 'abandon') {
          await transition(trx, post, { type: 'abandon', reason: decision.reason }, now);
          report.abandoned.push(post.id);
          continue;
        }
        if (decision.kind === 'move') {
          await trx
            .updateTable('posts')
            .set({ scheduled_at: decision.at, week_start: weekStartOf(decision.at, calendar) })
            .where('id', '=', post.id)
            .execute();
          report.moved.push(post.id);
          continue;
        }
      }

      await transition(trx, post, { type: 'startPublishing' }, now, {
        publish_retries_left: RETRY_DELAYS_MINUTES.length,
        next_publish_attempt_at: now,
        publish_lease_until: null,
        last_error: null,
      });
      report.started.push(post.id);
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Tentatives
// ---------------------------------------------------------------------------

interface ClaimedAttempt {
  readonly attemptId: string;
  readonly post: PostRef & { readonly account_id: string };
  readonly authorUrn: string;
  readonly encryptedToken: Uint8Array | null;
  readonly body: string | null;
  readonly media: readonly { storage_key: string; mime: string; alt_text: string | null }[];
}

async function claimNextAttempt(deps: PublicationDeps, now: Date): Promise<ClaimedAttempt | null> {
  const lease = deps.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
  return asSystem(deps.db, async (trx) => {
    const post = await trx
      .selectFrom('posts')
      .select(['id', 'workspace_id', 'account_id', 'status', 'current_version_id'])
      .where('status', '=', 'en_publication')
      .where('next_publish_attempt_at', '<=', now)
      .where((eb) => eb.or([eb('publish_lease_until', 'is', null), eb('publish_lease_until', '<', now)]))
      .orderBy('next_publish_attempt_at')
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (post === undefined) return null;

    const last = await trx
      .selectFrom('publish_attempts')
      .select((eb) => eb.fn.max('attempt').as('attempt'))
      .where('post_id', '=', post.id)
      .executeTakeFirst();
    const attempt = (last?.attempt ?? 0) + 1;

    await trx
      .updateTable('posts')
      .set({ publish_lease_until: addMinutes(now, lease), next_publish_attempt_at: null })
      .where('id', '=', post.id)
      .execute();
    const attemptRow = await trx
      .insertInto('publish_attempts')
      .values({ workspace_id: post.workspace_id, post_id: post.id, attempt, idempotency_key: `${post.id}:${attempt}`, started_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();

    const account = await trx
      .selectFrom('social_accounts as a')
      .leftJoin('social_tokens as t', 't.account_id', 'a.id')
      .select(['a.external_urn', 't.access_token_enc'])
      .where('a.id', '=', post.account_id)
      .executeTakeFirstOrThrow();
    const version =
      post.current_version_id === null
        ? undefined
        : await trx.selectFrom('post_versions').select('body').where('id', '=', post.current_version_id).executeTakeFirst();
    const media = await trx
      .selectFrom('post_media as pm')
      .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
      .select(['m.storage_key', 'm.mime', 'pm.alt_text'])
      .where('pm.post_id', '=', post.id)
      .orderBy('pm.position')
      .execute();

    return {
      attemptId: attemptRow.id,
      post,
      authorUrn: account.external_urn,
      encryptedToken: account.access_token_enc,
      body: version?.body ?? null,
      media,
    };
  });
}

/** Échec survenu chez nous, avant tout appel à LinkedIn : le post n'existe sûrement pas. */
function localFailure(message: string, retryable: boolean, kind: LinkedInError['kind'] = 'invalid'): LinkedInError {
  return new LinkedInError({
    kind: retryable ? 'network' : kind,
    phase: 'image_upload',
    outcome: 'not_created',
    message,
  });
}

async function processNextAttempt(deps: PublicationDeps, clock: () => Date, report: PublicationReport): Promise<boolean> {
  const claimed = await claimNextAttempt(deps, clock());
  if (claimed === null) return false;

  let outcome: { ok: true; postUrn: string; url: string } | { ok: false; error: LinkedInError };
  const prepared = await prepare(deps, claimed);
  if (!prepared.ok) {
    outcome = prepared;
  } else {
    try {
      const result = await deps.linkedin.publish(prepared.token, {
        authorUrn: claimed.authorUrn,
        text: prepared.text,
        images: prepared.images,
      });
      outcome = { ok: true, ...result };
    } catch (error) {
      // Une erreur inattendue du client peut survenir après l'envoi : issue incertaine.
      outcome = {
        ok: false,
        error:
          error instanceof LinkedInError
            ? error
            : new LinkedInError({ kind: 'server', phase: 'post_create', outcome: 'unknown', message: String(error), cause: error }),
      };
    }
  }

  const finishedAt = clock();
  if (outcome.ok) await recordSuccess(deps, claimed, outcome, finishedAt, report);
  else await recordFailure(deps, claimed, outcome.error, finishedAt, report);
  return true;
}

async function prepare(
  deps: PublicationDeps,
  claimed: ClaimedAttempt,
): Promise<{ ok: true; token: string; text: string; images: PublishImage[] } | { ok: false; error: LinkedInError }> {
  if (claimed.encryptedToken === null) {
    return { ok: false, error: localFailure('Aucune connexion LinkedIn enregistrée pour ce compte', false, 'auth') };
  }
  let token: string;
  try {
    token = deps.cipher.decrypt(claimed.encryptedToken, claimed.post.account_id);
  } catch {
    return { ok: false, error: localFailure('Connexion LinkedIn illisible : reconnectez le compte', false, 'auth') };
  }
  if (claimed.body === null) return { ok: false, error: localFailure('Le post n’a pas de texte', false) };

  const images: PublishImage[] = [];
  try {
    for (const item of claimed.media) {
      const bytes = await deps.media.read(item.storage_key);
      images.push({
        bytes,
        mime: item.mime as LinkedInImageMime,
        ...(item.alt_text === null ? {} : { altText: item.alt_text }),
      });
    }
  } catch (error) {
    // Stockage momentanément indisponible : sans danger, nouvel essai.
    return { ok: false, error: localFailure(`Image illisible : ${error instanceof Error ? error.message : String(error)}`, true) };
  }
  return { ok: true, token, text: claimed.body, images };
}

async function recordSuccess(
  deps: PublicationDeps,
  claimed: ClaimedAttempt,
  result: { postUrn: string; url: string },
  at: Date,
  report: PublicationReport,
) {
  await asSystem(deps.db, async (trx) => {
    await trx
      .updateTable('publish_attempts')
      .set({ finished_at: at, outcome: 'published', http_status: 201 })
      .where('id', '=', claimed.attemptId)
      .execute();
    await transition(trx, claimed.post, { type: 'markPublished' }, at, {
      published_at: at,
      external_post_urn: result.postUrn,
      external_post_url: result.url,
      publish_lease_until: null,
      last_error: null,
    });
    const holder = await trx.selectFrom('social_accounts').select('holder_user_id').where('id', '=', claimed.post.account_id).executeTakeFirst();
    if (holder?.holder_user_id) {
      await notify(trx, [holder.holder_user_id], claimed.post.workspace_id, 'post_publie', { postId: claimed.post.id, url: result.url }, ['in_app']);
    }
    await audit(trx, claimed.post.workspace_id, 'post.publie', claimed.post.id, { postUrn: result.postUrn }, at);
  });
  report.published.push(claimed.post.id);
}

async function recordFailure(
  deps: PublicationDeps,
  claimed: ClaimedAttempt,
  error: LinkedInError,
  at: Date,
  report: PublicationReport,
) {
  const message = describeForUser(error);
  await asSystem(deps.db, async (trx) => {
    await trx
      .updateTable('publish_attempts')
      .set({
        finished_at: at,
        outcome: error.outcome,
        http_status: error.status,
        error_code: error.code ?? error.kind,
        error_message: error.message,
      })
      .where('id', '=', claimed.attemptId)
      .execute();

    const current = await trx
      .selectFrom('posts')
      .select(['id', 'workspace_id', 'status', 'publish_retries_left'])
      .where('id', '=', claimed.post.id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const delay = RETRY_DELAYS_MINUTES[RETRY_DELAYS_MINUTES.length - current.publish_retries_left];
    if (error.retryable && current.publish_retries_left > 0 && delay !== undefined) {
      await trx
        .updateTable('posts')
        .set({
          publish_retries_left: current.publish_retries_left - 1,
          next_publish_attempt_at: addMinutes(at, delay),
          publish_lease_until: null,
          last_error: message,
        })
        .where('id', '=', current.id)
        .execute();
      report.retryScheduled.push(current.id);
      return;
    }

    await transition(trx, current, { type: 'markFailed', message }, at, {
      publish_lease_until: null,
      next_publish_attempt_at: null,
      last_error: message,
    });
    if (error.kind === 'auth') {
      // Le jeton ne fonctionne plus : les autres posts du compte attendront la reconnexion.
      await trx.updateTable('social_accounts').set({ status: 'expired' }).where('id', '=', claimed.post.account_id).execute();
    }
    const uncertain = error.outcome === 'unknown';
    const recipients = await alertRecipients(trx, current.workspace_id, claimed.post.account_id);
    await notify(trx, recipients, current.workspace_id, 'publication_erreur', { postId: current.id, message, uncertain }, ['email', 'in_app']);
    await audit(trx, current.workspace_id, uncertain ? 'post.publication_incertaine' : 'post.publication_echec', current.id, {
      kind: error.kind,
      status: error.status,
      code: error.code,
    }, at);
    (uncertain ? report.uncertain : report.failed).push(current.id);
  });
}

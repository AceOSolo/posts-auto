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
import { createHmac } from 'node:crypto';
import type { MediaStore } from '../media/media-store.ts';
import { enqueueTeamChat, workspaceNotBlockedByPayment, workspaceNotSuspended } from '@posts-auto/services';
import { alertRecipients, notify } from '../notifications/recipients.ts';
import type { TokenCipher } from '../secrets/token-cipher.ts';

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
  /** LNK-08 : appels aux webhooks des clients (remplaçable dans les tests). */
  readonly fetch?: typeof fetch;
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
  /** PUB-09 : envoyés par e-mail pour publication manuelle. */
  readonly manual: string[];
}

function emptyReport(): PublicationReport {
  return { started: [], published: [], retryScheduled: [], failed: [], uncertain: [], withdrawn: [], moved: [], abandoned: [], manual: [] };
}

export async function runPublicationTick(deps: PublicationDeps): Promise<PublicationReport> {
  const clock = deps.clock ?? (() => new Date());
  const report = emptyReport();
  await recoverInterruptedSends(deps, clock(), report);
  await startDuePosts(deps, clock(), report);
  await stopRetriesAfterEvent(deps, clock(), report);
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
        'a.publish_mode',
        'a.display_name',
        'a.holder_user_id',
        'v.body',
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
      .where(workspaceNotSuspended('p.workspace_id'))
      .where(workspaceNotBlockedByPayment('p.workspace_id', now))
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
      // PUB-09, LNK-08 : publication manuelle ou par webhook : pas besoin d'une connexion valable.
      const manual = post.publish_mode === 'manual';
      const viaApi = post.publish_mode === 'auto';
      if (viaApi && post.account_status !== 'connected' && post.account_status !== 'expiring') continue;
      if (!viaApi && (post.account_status === 'paused' || post.account_status === 'revoked')) continue;

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

      if (manual) {
        await sendForManualPublication(trx, post, now);
        report.manual.push(post.id);
        continue;
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

/**
 * PUB-09 : au créneau, le post validé part par e-mail au titulaire (texte et images) au lieu
 * de l'API ; il quitte la file comme publié, marqué « publication manuelle ».
 */
async function sendForManualPublication(
  trx: Tx,
  post: PostRef & { readonly account_id: string; readonly scheduled_at: Date; readonly body: string | null; readonly display_name: string | null; readonly holder_user_id: string | null },
  now: Date,
) {
  await transition(trx, post, { type: 'startPublishing' }, now, { publish_lease_until: null, last_error: null });
  await transition(trx, { ...post, status: 'en_publication' }, { type: 'markPublished' }, now, { published_at: now, published_manually: true });
  const images = await trx.selectFrom('post_media').select('asset_id').where('post_id', '=', post.id).execute();
  const recipients = post.holder_user_id !== null ? [post.holder_user_id] : await alertRecipients(trx, post.workspace_id, post.account_id);
  await notify(
    trx,
    recipients,
    post.workspace_id,
    'publication_manuelle',
    { postId: post.id, accountName: post.display_name ?? 'votre compte LinkedIn', scheduledAt: post.scheduled_at.toISOString(), body: post.body ?? '', images: images.length },
    ['email', 'in_app'],
  );
  await audit(trx, post.workspace_id, 'post.envoye_publication_manuelle', post.id, { recipients: recipients.length }, now);
}

// ---------------------------------------------------------------------------
// 3. Tentatives
// ---------------------------------------------------------------------------

const EVENT_PASSED_MESSAGE = 'L’événement annoncé par ce post est passé : la publication est arrêtée.';

/**
 * RÈG-11 : une nouvelle tentative ne part jamais après l'événement, y compris quand elle a
 * attendu la fin d'une suspension. Elle est programmée, donc aucun envoi n'est en cours.
 */
async function stopRetriesAfterEvent(deps: PublicationDeps, now: Date, report: PublicationReport) {
  await asSystem(deps.db, async (trx) => {
    const expired = await trx
      .selectFrom('posts')
      .select(['id', 'workspace_id', 'account_id', 'status'])
      .where('status', '=', 'en_publication')
      .where('next_publish_attempt_at', '<=', now)
      .where('must_publish_by', '<', now)
      .where((eb) => eb.or([eb('publish_lease_until', 'is', null), eb('publish_lease_until', '<', now)]))
      .where(workspaceNotSuspended('posts.workspace_id'))
      .where(workspaceNotBlockedByPayment('posts.workspace_id', now))
      .forUpdate()
      .skipLocked()
      .execute();
    for (const post of expired) {
      await transition(trx, post, { type: 'markFailed', message: EVENT_PASSED_MESSAGE }, now, {
        publish_lease_until: null,
        next_publish_attempt_at: null,
        last_error: EVENT_PASSED_MESSAGE,
      });
      const recipients = await alertRecipients(trx, post.workspace_id, post.account_id);
      await notify(trx, recipients, post.workspace_id, 'publication_erreur', { postId: post.id, message: EVENT_PASSED_MESSAGE, uncertain: false }, ['email', 'in_app']);
      await audit(trx, post.workspace_id, 'post.publication_echec', post.id, { cause: 'evenement_passe' }, now);
      report.failed.push(post.id);
    }
  });
}

interface ClaimedAttempt {
  readonly attemptId: string;
  readonly post: PostRef & { readonly account_id: string };
  readonly authorUrn: string;
  readonly accountName: string | null;
  readonly encryptedToken: Uint8Array | null;
  /** LNK-08 : le compte publie par un scénario du client. */
  readonly webhook: { readonly url: string; readonly secret: Uint8Array } | null;
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
      // Suspension de l'éditeur : les nouvelles tentatives attendent la réactivation.
      .where(workspaceNotSuspended('posts.workspace_id'))
      // FAC-06 : idem pendant un impayé. RÈG-11 : jamais après l'événement.
      .where(workspaceNotBlockedByPayment('posts.workspace_id', now))
      .where((eb) => eb.or([eb('must_publish_by', 'is', null), eb('must_publish_by', '>=', now)]))
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
      .leftJoin('account_webhooks as h', 'h.account_id', 'a.id')
      .select(['a.external_urn', 'a.display_name', 'a.publish_mode', 't.access_token_enc', 'h.url as webhook_url', 'h.secret_enc as webhook_secret'])
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
      accountName: account.display_name,
      encryptedToken: account.access_token_enc,
      webhook: account.publish_mode === 'webhook' && account.webhook_url !== null && account.webhook_secret !== null ? { url: account.webhook_url, secret: account.webhook_secret } : null,
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

  let outcome: { ok: true; postUrn: string | null; url: string | null } | { ok: false; error: LinkedInError };
  const prepared = claimed.webhook === null ? await prepare(deps, claimed) : await prepareWebhook(deps, claimed);
  if (!prepared.ok) {
    outcome = prepared;
  } else if (claimed.webhook !== null) {
    outcome = await sendToWebhook(deps, claimed, claimed.webhook, prepared.text, prepared.images, clock());
  } else {
    try {
      const result = await deps.linkedin.publish('token' in prepared ? String(prepared.token) : '', {
        authorUrn: claimed.authorUrn,
        text: prepared.text,
        images: prepared.images,
        ...('document' in prepared && prepared.document !== undefined && { document: prepared.document as { bytes: Uint8Array; title: string } }),
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
  if (outcome.ok) {
    await recordSuccess(deps, claimed, outcome, finishedAt, report);
    // PUB-07 : premier commentaire, par l'API seulement ; son échec ne touche pas au post.
    if (claimed.webhook === null && outcome.postUrn !== null && prepared.ok && 'token' in prepared) await postFirstComment(deps, claimed, String(prepared.token), outcome.postUrn);
  } else await recordFailure(deps, claimed, outcome.error, finishedAt, report);
  return true;
}

async function postFirstComment(deps: PublicationDeps, claimed: ClaimedAttempt, token: string, postUrn: string): Promise<void> {
  const row = await asSystem(deps.db, (trx) => trx.selectFrom('posts').select('first_comment').where('id', '=', claimed.post.id).executeTakeFirst());
  const text = row?.first_comment?.trim();
  if (!text) return;
  let status: 'posted' | 'failed' | 'skipped' = 'posted';
  let error: string | null = null;
  if (deps.linkedin.comment === undefined) {
    status = 'skipped';
    error = 'Commentaires non pris en charge';
  } else {
    try {
      await deps.linkedin.comment(token, { postUrn, actorUrn: claimed.authorUrn, text });
    } catch (e) {
      status = 'failed';
      error = e instanceof LinkedInError ? describeForUser(e) : String(e);
    }
  }
  await asSystem(deps.db, (trx) => trx.updateTable('posts').set({ first_comment_status: status, first_comment_error: error }).where('id', '=', claimed.post.id).execute());
}

async function prepare(
  deps: PublicationDeps,
  claimed: ClaimedAttempt,
): Promise<{ ok: true; token: string; text: string; images: PublishImage[]; document?: { bytes: Uint8Array; title: string } } | { ok: false; error: LinkedInError }> {
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
  let document: { bytes: Uint8Array; title: string } | undefined;
  try {
    for (const item of claimed.media) {
      const bytes = await deps.media.read(item.storage_key);
      // VIS-10 : carrousel PDF, publié comme document.
      if (item.mime === 'application/pdf') {
        document = { bytes, title: item.alt_text ?? 'Carrousel' };
        continue;
      }
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
  return { ok: true, token, text: claimed.body, images: document === undefined ? images : [], ...(document !== undefined && { document }) };
}

/** LNK-08 : texte et images, sans jeton LinkedIn. */
async function prepareWebhook(
  deps: PublicationDeps,
  claimed: ClaimedAttempt,
): Promise<{ ok: true; text: string; images: PublishImage[] } | { ok: false; error: LinkedInError }> {
  if (claimed.body === null) return { ok: false, error: localFailure('Le post n’a pas de texte', false) };
  const images: PublishImage[] = [];
  try {
    for (const item of claimed.media) {
      images.push({ bytes: await deps.media.read(item.storage_key), mime: item.mime as LinkedInImageMime, ...(item.alt_text === null ? {} : { altText: item.alt_text }) });
    }
  } catch (error) {
    return { ok: false, error: localFailure(`Image illisible : ${error instanceof Error ? error.message : String(error)}`, true) };
  }
  return { ok: true, text: claimed.body, images };
}

/**
 * LNK-08 : envoi du post validé au webhook du client (Make, Zapier, n8n…), signé :
 * en-tête X-Signature « t=<secondes>,v1=<HMAC-SHA256 hex de "t.corps"> ». Réponse 2xx :
 * publié (avec l'URN et le lien LinkedIn si le scénario les renvoie en JSON). Pas de
 * réponse ou 5xx : issue incertaine, comme pour LinkedIn (aucune nouvelle tentative).
 */
async function sendToWebhook(
  deps: PublicationDeps,
  claimed: ClaimedAttempt,
  webhook: { url: string; secret: Uint8Array },
  text: string,
  images: readonly PublishImage[],
  now: Date,
): Promise<{ ok: true; postUrn: string | null; url: string | null } | { ok: false; error: LinkedInError }> {
  let secret: string;
  try {
    secret = deps.cipher.decrypt(webhook.secret, `webhook:${claimed.post.account_id}`);
  } catch {
    return { ok: false, error: localFailure('Secret du webhook illisible : enregistrez de nouveau l’adresse du webhook', false) };
  }
  const body = JSON.stringify({
    event: 'post.a_publier',
    postId: claimed.post.id,
    idempotencyKey: claimed.attemptId,
    account: { id: claimed.post.account_id, name: claimed.accountName, urn: claimed.authorUrn },
    text,
    images: images.map((i, index) => ({ position: index + 1, mime: i.mime, altText: i.altText ?? null, base64: Buffer.from(i.bytes).toString('base64') })),
    sentAt: now.toISOString(),
  });
  const t = Math.floor(now.getTime() / 1000);
  const signature = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  let response: Response;
  try {
    response = await (deps.fetch ?? globalThis.fetch)(webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': `t=${t},v1=${signature}`, 'x-idempotency-key': claimed.attemptId },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, error: new LinkedInError({ kind: 'network', phase: 'post_create', outcome: 'unknown', message: `Webhook injoignable ou sans réponse : ${error instanceof Error ? error.message : String(error)}` }) };
  }
  if (!response.ok) {
    const uncertain = response.status >= 500;
    return {
      ok: false,
      error: new LinkedInError({ kind: uncertain ? 'server' : 'invalid', phase: 'post_create', outcome: uncertain ? 'unknown' : 'not_created', status: response.status, message: `Le webhook a répondu ${response.status}` }),
    };
  }
  const json = (await response.json().catch(() => ({}))) as { urn?: unknown; url?: unknown };
  const urn = typeof json.urn === 'string' && /^urn:li:(share|ugcPost):\d+$/.test(json.urn) ? json.urn : null;
  const url = typeof json.url === 'string' && /^https:\/\/(www\.)?linkedin\.com\//.test(json.url) ? json.url : null;
  return { ok: true, postUrn: urn, url };
}

async function recordSuccess(
  deps: PublicationDeps,
  claimed: ClaimedAttempt,
  result: { postUrn: string | null; url: string | null },
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
      // LNK-08 : publié par le scénario du client, sans identifiant LinkedIn connu.
      published_manually: result.postUrn === null,
      publish_lease_until: null,
      last_error: null,
    });
    const holder = await trx.selectFrom('social_accounts').select('holder_user_id').where('id', '=', claimed.post.account_id).executeTakeFirst();
    if (holder?.holder_user_id) {
      await notify(trx, [holder.holder_user_id], claimed.post.workspace_id, 'post_publie', { postId: claimed.post.id, url: result.url }, ['in_app']);
    }
    // Messagerie d'équipe : le post publié, à relayer par l'équipe.
    await enqueueTeamChat(trx, claimed.post.workspace_id, 'publies', { postId: claimed.post.id, url: result.url });
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

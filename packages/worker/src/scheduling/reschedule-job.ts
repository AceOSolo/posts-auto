/**
 * Replanification automatique des posts non validés à temps (RÈG-08 à RÈG-11, REC-07).
 * Exécutée toutes les 15 minutes (section 8.4).
 *
 * Délai de grâce d'une heure : un post manqué n'est décalé qu'une heure après son créneau.
 * Pendant cette heure, une validation le fait partir aussitôt (RÈG-06, REC-06 : « validé
 * 10 minutes après son créneau → publié dans l'heure »). Sans ce délai, la tâche pourrait
 * le décaler au lendemain juste avant que le titulaire ne valide.
 */
import {
  type Actor,
  SLOT_OCCUPYING_STATUSES,
  addMinutes,
  applyPostCommand,
  rescheduleMissedPost,
} from '@posts-auto/core';
import { type Database, type Tx, asSystem } from '@posts-auto/db';
import { calendarOf, slotRulesOf, weekStartOf } from '../workspace-settings.js';

export const MISSED_SLOT_GRACE_MINUTES = 60;
const BATCH = 100;
const SYSTEM: Actor = { kind: 'system' };

export interface RescheduleDeps {
  readonly db: Database;
  readonly clock?: () => Date;
}

export interface RescheduleReport {
  readonly moved: string[];
  readonly abandoned: string[];
}

/** « mardi 17 novembre à 12:00 », dans le fuseau de l'espace. */
export function describeSlot(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} à ${get('hour')}:${get('minute')}`;
}

export async function runRescheduleTick(deps: RescheduleDeps): Promise<RescheduleReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const report: RescheduleReport = { moved: [], abandoned: [] };

  await asSystem(deps.db, async (trx) => {
    const missed = await trx
      .selectFrom('posts as p')
      .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .select([
        'p.id',
        'p.workspace_id',
        'p.account_id',
        'p.status',
        'p.scheduled_at',
        'p.original_scheduled_at',
        'p.reschedule_count',
        'p.must_publish_by',
        'a.holder_user_id',
        'w.timezone',
        'w.allowed_hours',
        'w.holidays_calendar',
        'w.slot_step_minutes',
        'w.max_posts_per_account_per_day',
        'w.min_gap_minutes',
        'w.max_posts_per_slot',
      ])
      .where('p.status', '=', 'a_valider')
      .where('w.status', '=', 'active')
      .where('p.scheduled_at', '<', addMinutes(now, -MISSED_SLOT_GRACE_MINUTES))
      .orderBy('p.scheduled_at')
      .limit(BATCH)
      .forUpdate('p')
      .skipLocked()
      .execute();

    for (const post of missed) {
      const calendar = calendarOf(post);
      const occupied = await trx
        .selectFrom('posts')
        .select(['id as postId', 'account_id as accountId', 'scheduled_at as at'])
        .where('workspace_id', '=', post.workspace_id)
        .where('status', 'in', [...SLOT_OCCUPYING_STATUSES])
        .where('scheduled_at', '>=', addMinutes(now, -24 * 60))
        .where('scheduled_at', '<=', addMinutes(now, 35 * 24 * 60))
        .execute();

      const decision = rescheduleMissedPost(
        {
          postId: post.id,
          accountId: post.account_id,
          scheduledAt: post.scheduled_at,
          rescheduleCount: post.reschedule_count,
          ...(post.original_scheduled_at === null ? {} : { originalScheduledAt: post.original_scheduled_at }),
          ...(post.must_publish_by === null ? {} : { mustPublishBy: post.must_publish_by }),
        },
        now,
        { calendar, rules: slotRulesOf(post), occupied },
      );

      if (decision.kind === 'not_missed') continue;

      if (decision.kind === 'move') {
        const reason = `Replanifié faute de validation : ${describeSlot(post.scheduled_at, post.timezone)} → ${describeSlot(decision.at, post.timezone)} (RÈG-08)`;
        await trx
          .updateTable('posts')
          .set({
            scheduled_at: decision.at,
            week_start: weekStartOf(decision.at, calendar),
            reschedule_count: decision.rescheduleCount,
            original_scheduled_at: decision.originalScheduledAt,
          })
          .where('id', '=', post.id)
          .execute();
        // VAL-09 : la replanification figure dans l'historique du post (statut inchangé).
        await trx
          .insertInto('post_status_history')
          .values({ workspace_id: post.workspace_id, post_id: post.id, from_status: 'a_valider', to_status: 'a_valider', actor_kind: 'system', reason, at: now })
          .execute();
        await notifyHolder(trx, post, 'post_replanifie', {
          postId: post.id,
          from: post.scheduled_at.toISOString(),
          to: decision.at.toISOString(),
          movedToAnotherWeek: decision.movedToAnotherWeek,
        });
        report.moved.push(post.id);
        continue;
      }

      const result = applyPostCommand({ status: post.status, hasBlockingMarkers: false }, { type: 'abandon', reason: decision.reason }, SYSTEM, now);
      if (!result.ok) throw new Error(`Abandon refusé pour le post ${post.id} : ${result.error}`);
      await trx.updateTable('posts').set({ status: result.status }).where('id', '=', post.id).execute();
      await trx
        .insertInto('post_status_history')
        .values({ workspace_id: post.workspace_id, post_id: post.id, from_status: result.change.from, to_status: result.change.to, actor_kind: 'system', reason: result.change.reason, at: now })
        .execute();
      await notifyHolder(trx, post, 'post_abandonne', { postId: post.id, reason: decision.reason });
      report.abandoned.push(post.id);
    }
  });

  return report;
}

async function notifyHolder(
  trx: Tx,
  post: { workspace_id: string; holder_user_id: string | null },
  kind: string,
  payload: Record<string, unknown>,
) {
  if (post.holder_user_id === null) return;
  await trx
    .insertInto('notifications')
    .values({ user_id: post.holder_user_id, workspace_id: post.workspace_id, kind, channel: 'in_app', payload: JSON.stringify(payload) })
    .execute();
}

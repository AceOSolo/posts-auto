/**
 * Rappels de validation (VAL-05, NOT « rappel avant créneau » et « posts de la semaine prêts »),
 * toutes les 15 minutes :
 * - 24 heures puis 3 heures avant le créneau d'un post non validé, au titulaire et à ses
 *   délégués. Chaque rappel est lié au créneau annoncé : un post replanifié en reçoit de
 *   nouveaux. Si les deux seuils sont franchis d'un coup (post déposé peu avant son
 *   créneau), seul le plus urgent part.
 * - Récapitulatif le lundi matin (à partir de 8 h, après la rédaction de 7 h 30, GEN-01) :
 *   une notification par personne et par semaine, avec le nombre de posts à valider.
 */
import { DEFAULT_WORKSPACE_CALENDAR, isoWeekBounds, localDate, toLocal } from '@posts-auto/core';
import { type Database, type Tx, asSystem } from '@posts-auto/db';
import { sql } from 'kysely';
import { notify } from './recipients.ts';

const HOUR = 3_600_000;
export const REMINDER_THRESHOLDS_HOURS = [24, 3] as const;
export const WEEKLY_RECAP_HOUR = 8;

export interface RemindersDeps {
  readonly db: Database;
  readonly clock?: () => Date;
}

export interface RemindersReport {
  readonly reminders: string[];
  readonly recaps: string[];
}

/** Titulaire du compte et validateurs délégués (ROL-01). */
async function deciders(trx: Tx, accountId: string): Promise<string[]> {
  const holder = await trx.selectFrom('social_accounts').select('holder_user_id').where('id', '=', accountId).executeTakeFirst();
  const delegates = await trx.selectFrom('account_delegates').select('user_id').where('account_id', '=', accountId).execute();
  return [...new Set([holder?.holder_user_id, ...delegates.map((d) => d.user_id)].filter((id): id is string => typeof id === 'string'))];
}

export async function runValidationReminders(deps: RemindersDeps): Promise<RemindersReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const report: RemindersReport = { reminders: [], recaps: [] };

  await asSystem(deps.db, async (trx) => {
    const pending = await trx
      .selectFrom('posts as p')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .select(['p.id', 'p.workspace_id', 'p.account_id', 'p.scheduled_at', 'p.reminders_sent', 'a.display_name'])
      .where('p.status', '=', 'a_valider')
      .where('p.scheduled_at', '>', now)
      .where('p.scheduled_at', '<=', new Date(now.getTime() + 24 * HOUR))
      .where('w.status', '=', 'active')
      .where('o.status', 'in', ['active', 'past_due'])
      .forUpdate('p')
      .skipLocked()
      .execute();

    for (const post of pending) {
      const slot = post.scheduled_at.toISOString();
      const hoursLeft = (post.scheduled_at.getTime() - now.getTime()) / HOUR;
      const crossed = REMINDER_THRESHOLDS_HOURS.filter((t) => hoursLeft <= t);
      const due = crossed.filter((t) => !post.reminders_sent.includes(`${t}h@${slot}`));
      if (due.length === 0) continue;
      const hours = Math.min(...due); // le plus urgent seulement
      const recipients = await deciders(trx, post.account_id);
      await notify(
        trx,
        recipients,
        post.workspace_id,
        'rappel_validation',
        { postId: post.id, accountName: post.display_name, scheduledAt: slot, hours },
        ['email', 'in_app'],
      );
      await trx
        .updateTable('posts')
        .set({ reminders_sent: [...post.reminders_sent, ...crossed.map((t) => `${t}h@${slot}`)] })
        .where('id', '=', post.id)
        .execute();
      report.reminders.push(`${post.id}:${hours}h`);
    }

    // Récapitulatif du lundi matin, dans le fuseau de chaque espace.
    const workspaces = await trx.selectFrom('workspaces').select(['id', 'timezone']).where('status', '=', 'active').execute();
    for (const workspace of workspaces) {
      const calendar = { ...DEFAULT_WORKSPACE_CALENDAR, timeZone: workspace.timezone };
      const local = toLocal(now, calendar);
      if (local.weekday !== 1 || local.hour < WEEKLY_RECAP_HOUR) continue;
      const { start, end } = isoWeekBounds(now, calendar);
      const week = localDate(start, calendar);

      const posts = await trx
        .selectFrom('posts as p')
        .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
        .select(['p.account_id'])
        .where('p.workspace_id', '=', workspace.id)
        .where('p.status', '=', 'a_valider')
        .where('p.scheduled_at', '>=', start)
        .where('p.scheduled_at', '<', end)
        .execute();
      const counts = new Map<string, number>();
      for (const post of posts) {
        for (const userId of await deciders(trx, post.account_id)) counts.set(userId, (counts.get(userId) ?? 0) + 1);
      }
      for (const [userId, count] of counts) {
        const already = await trx
          .selectFrom('notifications')
          .select('id')
          .where('user_id', '=', userId)
          .where('workspace_id', '=', workspace.id)
          .where('kind', '=', 'recap_hebdo')
          .where(sql<string>`payload ->> 'week'`, '=', week)
          .executeTakeFirst();
        if (already !== undefined) continue;
        await notify(trx, [userId], workspace.id, 'recap_hebdo', { week, count }, ['email', 'in_app']);
        report.recaps.push(`${userId}:${week}`);
      }
    }
  });
  return report;
}

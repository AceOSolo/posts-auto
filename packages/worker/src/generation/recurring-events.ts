/**
 * Rendez-vous récurrents (EDI-08) : les occurrences des 60 prochains jours sont créées comme
 * des événements ordinaires, avec les comptes de l'événement modèle. La rédaction les relaie
 * ensuite comme tout événement (PLA-04) : un relais par compte et par occurrence.
 * Idempotent : une occurrence déjà créée ne l'est pas deux fois.
 */
import { type Recurrence, addDays, occurrences } from '@posts-auto/core';
import { type Database, asSystem } from '@posts-auto/db';

export const RECURRING_HORIZON_DAYS = 60;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export async function materializeRecurringEvents(db: Database, now: Date, workspaceId?: string): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const horizon = addDays(today, RECURRING_HORIZON_DAYS);
  return asSystem(db, async (trx) => {
    let query = trx
      .selectFrom('events')
      .select(['id', 'workspace_id', 'title', 'starts_on', 'ends_on', 'link', 'details', 'recurrence', 'recurrence_until', 'created_by'])
      .where('recurrence', '<>', 'none');
    if (workspaceId !== undefined) query = query.where('workspace_id', '=', workspaceId);
    const roots = await query.execute();
    let created = 0;
    for (const root of roots) {
      const accounts = await trx.selectFrom('event_accounts').select('account_id').where('event_id', '=', root.id).execute();
      const length = root.ends_on === null ? null : daysBetween(root.starts_on, root.ends_on);
      for (const date of occurrences(root.starts_on, root.recurrence as Recurrence, root.recurrence_until, today, horizon)) {
        // L'événement modèle est lui-même la première occurrence.
        if (date === root.starts_on) continue;
        const row = await trx
          .insertInto('events')
          .values({
            workspace_id: root.workspace_id,
            title: root.title,
            starts_on: date,
            ends_on: length === null ? null : addDays(date, length),
            link: root.link,
            details: root.details,
            series_id: root.id,
            created_by: root.created_by,
          })
          .onConflict((oc) => oc.columns(['series_id', 'starts_on']).where('series_id', 'is not', null).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (row === undefined) continue;
        created += 1;
        if (accounts.length > 0) {
          await trx
            .insertInto('event_accounts')
            .values(accounts.map((a) => ({ event_id: row.id, account_id: a.account_id, workspace_id: root.workspace_id })))
            .execute();
        }
      }
    }
    return created;
  });
}

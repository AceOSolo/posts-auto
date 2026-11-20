/**
 * FAC-04 : alerte à 80 % puis à 100 % du quota de la période, une seule fois par seuil,
 * pour les espaces abonnés. Destinataires : administrateurs de l'espace et propriétaires de
 * l'organisation. L'appelant (tâche de fond) enregistre les notifications.
 */
import { type Database, asSystem } from '@posts-auto/db';
import { allowanceForWorkspace } from './allowance.ts';

export interface UsageAlert {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly kind: 'posts_80' | 'posts_100' | 'images_80' | 'images_100';
  readonly used: number;
  readonly limit: number;
  readonly overagePolicy: 'suspend' | 'packs';
  readonly recipientIds: readonly string[];
}

export const USAGE_ALERT_THRESHOLDS = [80, 100] as const;

export async function dueUsageAlerts(db: Database, now: Date): Promise<UsageAlert[]> {
  return asSystem(db, async (trx) => {
    const workspaces = await trx
      .selectFrom('workspaces as w')
      .innerJoin('subscriptions as s', 's.org_id', 'w.org_id')
      .select(['w.id', 'w.name', 'w.org_id'])
      .where('s.status', 'in', ['active', 'past_due'])
      .execute();
    const alerts: UsageAlert[] = [];
    for (const w of workspaces) {
      const allowance = await allowanceForWorkspace(trx, w.id, now);
      if (allowance.mode !== 'subscribed' || allowance.periodStart === null) continue;
      for (const [resource, q] of [['posts', allowance.posts], ['images', allowance.images]] as const) {
        if (q.limit === null || q.limit === 0) continue;
        const ratio = (q.used / q.limit) * 100;
        // Seul le seuil le plus haut franchi est signalé (pas deux alertes d'un coup).
        const threshold = [...USAGE_ALERT_THRESHOLDS].reverse().find((t) => ratio >= t);
        if (threshold === undefined) continue;
        const kind = `${resource}_${threshold}` as UsageAlert['kind'];
        const lower = USAGE_ALERT_THRESHOLDS.filter((t) => t <= threshold).map((t) => `${resource}_${t}` as UsageAlert['kind']);
        const inserted = await trx
          .insertInto('usage_alerts')
          .values(lower.map((k) => ({ workspace_id: w.id, period_start: allowance.periodStart as Date, kind: k, sent_at: now })))
          .onConflict((oc) => oc.columns(['workspace_id', 'period_start', 'kind']).doNothing())
          .returning('kind')
          .execute();
        if (!inserted.some((r) => r.kind === kind)) continue;
        const admins = await trx.selectFrom('workspace_members').select('user_id').where('workspace_id', '=', w.id).where('role', '=', 'admin').execute();
        const owners = await trx.selectFrom('org_members').select('user_id').where('org_id', '=', w.org_id).where('role', '=', 'owner').execute();
        alerts.push({
          workspaceId: w.id,
          workspaceName: w.name,
          kind,
          used: q.used,
          limit: q.limit,
          overagePolicy: allowance.overagePolicy,
          recipientIds: [...new Set([...admins, ...owners].map((r) => r.user_id))],
        });
      }
    }
    return alerts;
  });
}

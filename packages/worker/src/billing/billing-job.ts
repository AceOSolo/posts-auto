/**
 * Facturation, toutes les heures (FAC-02, FAC-04, FAC-06) :
 *
 * 1. quantité facturée = comptes actifs, transmise à Stripe (ajout au prorata) ;
 * 2. relances d'impayé à J+3 et J+7, suspension à J+14 (propriétaires de l'organisation) ;
 * 3. alerte à 80 % et à 100 % du quota du mois (administrateurs et propriétaires) ;
 * 4. suppression des données 90 jours après la suspension, médias compris.
 *
 * Sans fournisseur de paiement configuré, l'étape 1 est sautée ; le reste tourne quand même.
 */
import { type Database, asSystem } from '@posts-auto/db';
import { type BillingProvider, dueDunningNotices, dueUsageAlerts, purgeExpiredSuspensions, syncSubscriptionQuantities } from '@posts-auto/services';
import type { MediaStore } from '../media/media-store.ts';
import { notify } from '../notifications/recipients.ts';

export interface BillingJobDeps {
  readonly db: Database;
  readonly provider: BillingProvider | null;
  readonly media: MediaStore;
  readonly clock?: () => Date;
}

export interface BillingJobReport {
  readonly quantities: number;
  readonly dunning: number;
  readonly usageAlerts: number;
  readonly purged: readonly string[];
}

export async function runBillingTick(deps: BillingJobDeps): Promise<BillingJobReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const { db } = deps;
  const quantities = deps.provider === null ? { updated: [] } : await syncSubscriptionQuantities(db, deps.provider, now);

  const dunning = await dueDunningNotices(db, now);
  for (const notice of dunning) {
    await asSystem(db, async (trx) => {
      const first = await trx.selectFrom('workspaces').select('id').where('org_id', '=', notice.orgId).orderBy('created_at').executeTakeFirst();
      if (first !== undefined) await notify(trx, notice.ownerIds, first.id, 'impaye', { step: notice.step, workspaceId: first.id }, ['email', 'in_app']);
    });
  }

  const alerts = await dueUsageAlerts(db, now);
  for (const alert of alerts) {
    await asSystem(db, (trx) =>
      notify(
        trx,
        alert.recipientIds,
        alert.workspaceId,
        'quota_alerte',
        { kind: alert.kind, used: alert.used, limit: alert.limit, workspaceId: alert.workspaceId, workspaceName: alert.workspaceName, packs: alert.overagePolicy === 'packs' },
        ['email', 'in_app'],
      ),
    );
  }

  const purged = await purgeExpiredSuspensions(db, now);
  for (const org of purged) for (const key of org.storageKeys) await deps.media.remove(key).catch(() => undefined);

  return { quantities: quantities.updated.length, dunning: dunning.length, usageAlerts: alerts.length, purged: purged.map((p) => p.orgId) };
}

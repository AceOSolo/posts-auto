/**
 * Début de mois (SUI-04, SUI-05), chaque jour : enseignements du mois écoulé de chaque
 * espace, réinjectés dans la rédaction ; rapport PDF envoyé aux administrateurs des espaces
 * qui l'ont demandé (le PDF est produit et joint à l'envoi de l'e-mail).
 */
import { type Database, asSystem } from '@posts-auto/db';
import { closeMonth } from '@posts-auto/services';
import { notify } from '../notifications/recipients.ts';

export async function runMonthlyTick(deps: { readonly db: Database; readonly clock?: () => Date }): Promise<{ insights: number; reports: number }> {
  const now = (deps.clock ?? (() => new Date()))();
  const { insights, reports } = await closeMonth(deps.db, now);
  for (const report of reports) {
    await asSystem(deps.db, (trx) => notify(trx, report.recipientIds, report.workspaceId, 'rapport_mensuel', { workspaceId: report.workspaceId, month: report.month.toISOString() }, ['email']));
  }
  return { insights, reports: reports.length };
}

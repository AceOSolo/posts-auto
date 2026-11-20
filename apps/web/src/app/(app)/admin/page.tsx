import { type PaymentState, activeSupportGrants, listOrganizations } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Flash } from '../../../components/flash.tsx';
import { requireAdmin } from '../../../server/admin.ts';
import { database } from '../../../server/context.ts';
import { openSupportSessionAction } from './actions.ts';

export const metadata: Metadata = { title: 'Back-office' };
export const dynamic = 'force-dynamic';

const PAYMENT_LABELS: Record<PaymentState, string> = {
  pilote: 'pilote',
  essai: 'essai',
  essai_termine: 'essai terminé',
  a_jour: 'à jour',
  impaye: 'impayé',
  suspendu: 'suspendu',
  resilie: 'résilié',
  paiement_non_abouti: 'paiement non abouti',
};
const euros = (cents: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** ADM-01 : organisations clientes. */
export default async function AdminHome({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const adminId = await requireAdmin();
  const { message, q } = await searchParams;
  const search = typeof q === 'string' ? q.slice(0, 80) : '';
  const now = new Date();
  const rows = await listOrganizations(database(), adminId, now, search);
  const grants = await activeSupportGrants(database(), adminId, now);
  const mrr = rows.reduce((sum, r) => sum + (r.mrrCents ?? 0), 0);
  const cost = rows.reduce((sum, r) => sum + r.aiCostEurThisMonth, 0);

  return (
    <>
      <h1>Organisations</h1>
      <Flash code={message} />
      <ul className="stat-tiles">
        <li>
          <strong>{rows.length}</strong> organisation{rows.length > 1 ? 's' : ''}
        </li>
        <li>
          <strong>{rows.filter((r) => r.paymentState === 'a_jour' || r.paymentState === 'impaye').length}</strong> abonnées
        </li>
        <li>
          <strong>{euros(mrr)}</strong> HT de revenu mensuel
        </li>
        <li>
          <strong>{cost.toFixed(2).replace('.', ',')} €</strong> de coût IA ce mois
        </li>
      </ul>

      {grants.length > 0 && (
        <section aria-labelledby="support">
          <h2 id="support">Accès du support accordés</h2>
          <ul>
            {grants.map((g) => (
              <li key={g.id}>
                <strong>{g.orgName}</strong> · {g.workspaceName} · par {g.grantedBy} jusqu’au {date.format(g.expiresAt)}
                {g.reason && <> · « {g.reason} »</>}
                <form action={openSupportSessionAction.bind(null, g.id)} className="inline-fields">
                  <button type="submit">Ouvrir une session support</button>
                </form>
              </li>
            ))}
          </ul>
          <p className="hint">La session s’ouvre au nom de la personne qui a donné l’accord, remplace la vôtre sur ce navigateur et est inscrite au journal d’audit du client.</p>
        </section>
      )}

      <form className="filters" role="search">
        <label>
          Rechercher <input name="q" defaultValue={search} />
        </label>
        <button type="submit">Filtrer</button>
      </form>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Organisation</th>
              <th scope="col">Formule</th>
              <th scope="col">Paiement</th>
              <th scope="col">Espaces</th>
              <th scope="col">Comptes actifs</th>
              <th scope="col">Posts du mois</th>
              <th scope="col">Images du mois</th>
              <th scope="col">Coût IA du mois</th>
              <th scope="col">Revenu mensuel HT</th>
              <th scope="col">Dernière activité</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row">
                  <Link href={`/admin/organisations/${r.id}`}>{r.name}</Link> <span className="muted">({r.kind})</span>
                </th>
                <td>{r.planName === null ? '—' : `${r.planName}${r.interval === 'year' ? ' (annuel)' : ''}`}</td>
                <td>{PAYMENT_LABELS[r.paymentState]}</td>
                <td>{r.workspaces}</td>
                <td>{r.activeAccounts}</td>
                <td>{r.postsThisMonth}</td>
                <td>{r.imagesThisMonth}</td>
                <td>{r.aiCostEurThisMonth.toFixed(2).replace('.', ',')} €</td>
                <td>{r.mrrCents === null ? 'prix inconnu' : euros(r.mrrCents)}</td>
                <td>{r.lastActivityAt === null ? '—' : date.format(r.lastActivityAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

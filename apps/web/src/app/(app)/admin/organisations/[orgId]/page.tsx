import { NotFoundError, organizationDetail } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '../../../../../server/admin.ts';
import { database } from '../../../../../server/context.ts';
import { openSupportSessionAction } from '../../actions.ts';

export const metadata: Metadata = { title: 'Organisation' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** ADM-01 : fiche d'une organisation. Pas de contenu des posts : seulement des compteurs. */
export default async function OrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const adminId = await requireAdmin();
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  let org;
  try {
    org = await organizationDetail(database(), adminId, orgId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <>
      <p>
        <Link href="/admin">← Organisations</Link>
      </p>
      <h1>{org.name}</h1>
      <ul>
        <li>
          {org.kind === 'agence' ? 'Agence' : 'Entreprise'}, créée le {date.format(org.createdAt)} · statut {org.status}
        </li>
        {org.trialEndsAt && <li>Fin de l’essai : {date.format(org.trialEndsAt)}</li>}
        <li>
          {org.subscription === null
            ? 'Pas d’abonnement'
            : `Formule ${org.subscription.planName} (${org.subscription.interval === 'year' ? 'annuel' : 'mensuel'}), ${org.subscription.status}, ${org.subscription.quantity} compte(s), échéance ${date.format(org.subscription.periodEnd)}${org.subscription.cancelAtPeriodEnd ? ', résiliation programmée' : ''}`}
        </li>
        {org.stripeCustomerId && <li>Client Stripe : {org.stripeCustomerId}</li>}
      </ul>

      <h2>Espaces</h2>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Tableau, défilable horizontalement">
        <table>
          <thead>
            <tr>
              <th scope="col">Espace</th>
              <th scope="col">Comptes actifs</th>
              <th scope="col">Publiés (30 jours)</th>
              <th scope="col">À valider</th>
            </tr>
          </thead>
          <tbody>
            {org.workspaces.map((w) => (
              <tr key={w.id}>
                <th scope="row">{w.name}</th>
                <td>{w.accounts}</td>
                <td>{w.published30d}</td>
                <td>{w.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Personnes</h2>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Tableau, défilable horizontalement">
        <table>
          <thead>
            <tr>
              <th scope="col">Adresse</th>
              <th scope="col">Nom</th>
              <th scope="col">Rôles</th>
              <th scope="col">Dernière connexion</th>
              <th scope="col">Double authentification</th>
            </tr>
          </thead>
          <tbody>
            {org.people.map((p) => (
              <tr key={p.email}>
                <th scope="row">{p.email}</th>
                <td>{p.name ?? '—'}</td>
                <td>{p.roles}</td>
                <td>{p.lastLoginAt === null ? '—' : date.format(p.lastLoginAt)}</td>
                <td>{p.mfa ? 'oui' : 'non'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Accès du support (ADM-02)</h2>
      {org.supportGrants.length === 0 ? (
        <p className="muted">Aucun accès accordé en ce moment. Le client l’accorde depuis les réglages de son espace.</p>
      ) : (
        <ul>
          {org.supportGrants.map((g) => (
            <li key={g.id}>
              {g.workspaceName} · par {g.grantedBy} jusqu’au {date.format(g.expiresAt)}
              {g.reason && <> · « {g.reason} »</>}
              <form action={openSupportSessionAction.bind(null, g.id)} className="inline-fields">
                <button type="submit">Ouvrir une session support</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

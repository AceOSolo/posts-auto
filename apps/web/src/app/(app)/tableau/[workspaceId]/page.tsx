import { NotFoundError, monthlyOverview, workspaceDashboard } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { PageHeader } from '../../../../components/page-header.tsx';
import { STATUS_LABELS } from '../../../../components/status-badge.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { reportEmailAction } from './actions.ts';
import styles from './tableau.module.css';

export const metadata: Metadata = { title: 'Tableau de bord' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const percent = (part: number, total: number) => (total === 0 ? '—' : `${Math.round((part / total) * 100)} %`);

/** SUI-01, SUI-02 : l'état de l'espace en un coup d'œil, et les indicateurs des 8 dernières semaines. */
export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let dashboard;
  let monthly;
  try {
    dashboard = await workspaceDashboard(database(), userId, workspaceId, new Date());
    monthly = await monthlyOverview(database(), userId, workspaceId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const when = new Intl.DateTimeFormat('fr-FR', { timeZone: dashboard.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const statuses = Object.entries(dashboard.byStatus) as [keyof typeof STATUS_LABELS, number][];
  const hasIssues = dashboard.errors.length > 0 || dashboard.accountsToReconnect.length > 0;

  return (
    <>
      <PageHeader
        title="Tableau de bord"
        description={dashboard.workspaceName}
        action={
          <Link href={`/equipe/${workspaceId}`} className="button">
            Posts de la semaine
          </Link>
        }
        menu={[
          { label: 'Exporter tous les posts (CSV)', href: `/tableau/${workspaceId}/export`, download: true },
          { label: 'Rapport PDF du mois en cours', href: `/tableau/${workspaceId}/rapport`, download: true },
          { label: 'Rapport PDF du mois dernier', href: `/tableau/${workspaceId}/rapport?mois=precedent`, download: true },
        ]}
      />
      <Flash code={message} />

      {hasIssues && (
        <section aria-labelledby="a-traiter" className={`card ${styles.alert}`}>
          <h2 id="a-traiter">À traiter</h2>
          <ul>
            {dashboard.accountsToReconnect.map((a) => (
              <li key={a.id}>
                {a.name} : {a.status === 'expired' ? 'connexion expirée' : 'connexion bientôt expirée'}. <Link href={`/comptes/${workspaceId}`}>Reconnecter</Link>
              </li>
            ))}
            {dashboard.errors.map((p) => (
              <li key={p.postId}>
                <Link href={`/posts/${p.postId}`}>{p.accountName}</Link>, {when.format(p.scheduledAt)} : {p.lastError ?? 'erreur de publication'}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="semaine">
        <h2 id="semaine">Cette semaine</h2>
        {statuses.length === 0 ? (
          <p className="muted">Aucun post cette semaine.</p>
        ) : (
          <ul className="stat-tiles">
            {statuses.map(([status, count]) => (
              <li key={status}>
                <strong>{count}</strong> {STATUS_LABELS[status]}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className={styles.grid}>
        <section aria-labelledby="attente" className="card">
          <h2 id="attente">En attente de validation</h2>
          {dashboard.pendingByHolder.length === 0 ? (
            <p className="muted">Rien en attente.</p>
          ) : (
            <ul>
              {dashboard.pendingByHolder.map((h) => (
                <li key={h.holder}>
                  <strong>{h.holder}</strong> : {h.count} post{h.count > 1 ? 's' : ''}, le premier part {when.format(h.nextAt)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="departs" className="card">
          <h2 id="departs">Prochains départs (7 jours)</h2>
          {dashboard.nextDepartures.length === 0 ? (
            <p className="muted">Aucun post validé dans les 7 jours.</p>
          ) : (
            <ul>
              {dashboard.nextDepartures.map((p) => (
                <li key={p.postId}>
                  {when.format(p.scheduledAt)} · <Link href={`/posts/${p.postId}`}>{p.accountName}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* SUI-03, SUI-04 : statistiques LinkedIn et enseignements. */}
      <section aria-labelledby="statistiques-titre" id="statistiques">
        <h2 id="statistiques-titre">Statistiques LinkedIn du mois</h2>
        {monthly.totals.withStats === 0 ? (
          <p className="muted">Pas encore de statistiques ce mois-ci : elles arrivent quelques jours après la publication.</p>
        ) : (
          <ul className="stat-tiles">
            <li>
              <strong>{new Intl.NumberFormat('fr-FR').format(monthly.totals.impressions)}</strong> impressions
            </li>
            <li>
              <strong>{monthly.totals.reactions}</strong> réactions
            </li>
            <li>
              <strong>{monthly.totals.comments}</strong> commentaires
            </li>
            <li>
              <strong>{monthly.totals.shares}</strong> partages
            </li>
          </ul>
        )}
        {monthly.followers.map((f) => (
          <p key={f.name}>
            Abonnés de {f.name} : {f.start} → {f.end}
          </p>
        ))}
        <h3>Enseignements du mois dernier</h3>
        {monthly.lastInsights === null || monthly.lastInsights.insights.length === 0 ? (
          <p className="muted">Pas encore assez de posts mesurés ou de décisions pour tirer un enseignement fiable.</p>
        ) : (
          <>
            <ul>
              {monthly.lastInsights.insights.map((i) => (
                <li key={i.title}>
                  <strong>{i.title}</strong> · {i.detail}
                </li>
              ))}
            </ul>
            <p className="hint">Ces enseignements sont transmis à la rédaction du mois en cours.</p>
          </>
        )}
      </section>

      <div className={styles.foot}>
        <details>
          <summary>Indicateurs des 8 dernières semaines</summary>
          {dashboard.tracking.length === 0 ? (
            <p className="muted">Pas encore de post sur la période.</p>
          ) : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Indicateurs par compte, tableau défilable horizontalement">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Compte</th>
                    <th scope="col">Proposés</th>
                    <th scope="col">Validés tels quels</th>
                    <th scope="col">Modifiés</th>
                    <th scope="col">Refusés</th>
                    <th scope="col">Délai médian</th>
                    <th scope="col">Publiés à l’heure</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.tracking.map((t) => {
                    const sum = (key: 'proposed' | 'validatedAsIs' | 'validatedModified' | 'refused' | 'published' | 'onTime') => t.weeks.reduce((n, w) => n + w[key], 0);
                    const decided = sum('validatedAsIs') + sum('validatedModified');
                    const delays = t.weeks.map((w) => w.medianDecisionHours).filter((h): h is number => h !== null);
                    return (
                      <tr key={t.accountId}>
                        <th scope="row">{t.accountName}</th>
                        <td>{sum('proposed')}</td>
                        <td>{percent(sum('validatedAsIs'), decided)}</td>
                        <td>{percent(sum('validatedModified'), decided)}</td>
                        <td>{sum('refused')}</td>
                        <td>{delays.length === 0 ? '—' : `${Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)} h`}</td>
                        <td>{percent(sum('onTime'), sum('published'))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">Données produites par l’outil seulement. Le détail semaine par semaine est dans la vue de la semaine.</p>
        </details>

        {/* SUI-05 : rapport mensuel par e-mail. */}
        {monthly.canManage && (
          <details open={typeof message === 'string' && message.startsWith('rapport')}>
            <summary>Rapport mensuel par e-mail</summary>
            <form action={reportEmailAction.bind(null, workspaceId, !monthly.reportByEmail)}>
              <button type="submit">{monthly.reportByEmail ? 'Ne plus recevoir le rapport chaque mois' : 'Recevoir le rapport PDF chaque mois par e-mail'}</button>
            </form>
          </details>
        )}
      </div>
    </>
  );
}

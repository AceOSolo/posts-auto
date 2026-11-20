import { NotFoundError, monthlyOverview, workspaceDashboard } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { STATUS_LABELS } from '../../../../components/status-badge.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { reportEmailAction } from './actions.ts';

export const metadata: Metadata = { title: 'Tableau de bord' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const percent = (part: number, total: number) => (total === 0 ? '—' : `${Math.round((part / total) * 100)} %`);

/** SUI-01, SUI-02 : l'état de l'espace en un coup d'œil, et les indicateurs des 8 dernières semaines. */
export default async function DashboardPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
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

  return (
    <>
      <h1>Tableau de bord · {dashboard.workspaceName}</h1>
      <p>
        <a href={`/tableau/${workspaceId}/export`}>Exporter tous les posts (CSV)</a> · <Link href={`/planning/${workspaceId}/semaine`}>Document de la semaine</Link> ·{' '}
        <Link href={`/equipe/${workspaceId}`}>Vue équipe</Link>
      </p>

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

      <section aria-labelledby="attente">
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

      <section aria-labelledby="departs">
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

      {dashboard.errors.length > 0 && (
        <section aria-labelledby="erreurs">
          <h2 id="erreurs">Erreurs de publication</h2>
          <ul>
            {dashboard.errors.map((p) => (
              <li key={p.postId}>
                <Link href={`/posts/${p.postId}`}>{p.accountName}</Link>, {when.format(p.scheduledAt)} : {p.lastError ?? 'erreur'}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dashboard.accountsToReconnect.length > 0 && (
        <section aria-labelledby="reconnecter">
          <h2 id="reconnecter">Comptes à reconnecter</h2>
          <ul>
            {dashboard.accountsToReconnect.map((a) => (
              <li key={a.id}>
                {a.name} : {a.status === 'expired' ? 'connexion expirée' : 'connexion bientôt expirée'}. <Link href={`/comptes/${workspaceId}`}>Comptes</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="indicateurs">
        <h2 id="indicateurs">Indicateurs des 8 dernières semaines</h2>
        {dashboard.tracking.length === 0 ? (
          <p className="muted">Pas encore de post sur la période.</p>
        ) : (
          <div className="table-scroll">
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
        <p className="hint">Données produites par l’outil seulement. Le détail semaine par semaine est dans le document de la semaine.</p>
      </section>

      {/* SUI-03 à SUI-05 : statistiques LinkedIn, enseignements, rapport mensuel. */}
      <section aria-labelledby="statistiques">
        <h2 id="statistiques">Statistiques LinkedIn du mois</h2>
        {monthly.totals.withStats === 0 ? (
          <p className="muted">
            Pas encore de statistiques ce mois-ci : elles sont relevées à J+1, J+7 et J+30 après la publication, quand LinkedIn les donne pour le compte.
          </p>
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
          <ul>
            {monthly.lastInsights.insights.map((i) => (
              <li key={i.title}>
                <strong>{i.title}</strong> · {i.detail}
              </li>
            ))}
          </ul>
        )}
        <p className="hint">Ces enseignements sont transmis à la rédaction du mois en cours.</p>
        <p>
          <a href={`/tableau/${workspaceId}/rapport`}>Rapport PDF du mois en cours</a> · <a href={`/tableau/${workspaceId}/rapport?mois=precedent`}>du mois dernier</a>
        </p>
        {monthly.canManage && (
          <form action={reportEmailAction.bind(null, workspaceId, !monthly.reportByEmail)}>
            <button type="submit">{monthly.reportByEmail ? 'Ne plus recevoir le rapport chaque mois' : 'Recevoir le rapport PDF chaque mois par e-mail'}</button>
          </form>
        )}
      </section>
    </>
  );
}

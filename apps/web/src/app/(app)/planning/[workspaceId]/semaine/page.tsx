import { addDays } from '@posts-auto/core';
import { NotFoundError, cellKey, planningGrid, weekDocument } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '../../../../../components/page-header.tsx';
import { PrintButton } from '../../../../../components/print-button.tsx';
import { StatusBadge } from '../../../../../components/status-badge.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { PlanningBack, STATE_LABELS, mondayLabel } from '../../planning-ui.tsx';

export const metadata: Metadata = { title: 'Vue de la semaine' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateTime = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const ORIGINS: Record<string, string> = {
  planning: 'Planning',
  event: 'Événement',
  team_idea: 'Idée de l’équipe',
  ai_idea: 'Idée de l’IA',
  ai_reserve: 'Réserve',
  request: 'Demande',
  external_source: 'Source externe',
};
const pct = (part: number, total: number) => (total === 0 ? '–' : `${Math.round((100 * part) / total)} %`);

function weekTitle(week: string, currentWeek: string, isoWeek: number): string {
  if (week === currentWeek) return 'cette semaine';
  return week === addDays(currentWeek, 7) ? 'semaine prochaine' : `semaine ${isoWeek}`;
}

/** GEN-10 : document de semaine, imprimable (planning, posts, suivi des 8 dernières semaines). */
export default async function WeekDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { du } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let data;
  try {
    const doc = await weekDocument(database(), userId, workspaceId, typeof du === 'string' ? du : undefined, new Date());
    const grid = await planningGrid(database(), userId, workspaceId, { from: doc.weekStart, weeks: 2 }, new Date());
    data = { doc, grid };
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { doc, grid } = data;

  return (
    <>
      <PlanningBack workspaceId={workspaceId} />
      <PageHeader
        title={
          <>
            {doc.workspaceName} · semaine {doc.isoWeek} <small className="muted">du {mondayLabel(doc.weekStart)}</small>
          </>
        }
        action={<PrintButton label="Imprimer ou PDF" />}
      />
      <div className="toolbar split">
        <div className="segmented" role="group" aria-label="Semaine affichée">
          <Link href={`?du=${addDays(doc.weekStart, -7)}`} aria-label="Semaine précédente">
            ← Précédente
          </Link>
          <Link href={`?du=${addDays(doc.weekStart, 7)}`} aria-label="Semaine suivante">
            Suivante →
          </Link>
        </div>
      </div>

      {/* PLA-08 : les sujets de la semaine et de la suivante, ceux à traiter d'abord, avec leur post ou le motif de mise de côté. */}
      {grid.weeks.map((week) => {
        const items = grid.rows
          .flatMap((row) => (grid.entries[cellKey(row.row, week.weekStart)] ?? []).map((entry) => ({ row, entry })))
          .sort((a, b) => Number(b.entry.status.needsAttention) - Number(a.entry.status.needsAttention));
        return (
          <section key={week.weekStart} aria-labelledby={`sujets-${week.weekStart}`}>
            <h2 id={`sujets-${week.weekStart}`}>
              Sujets · {weekTitle(week.weekStart, grid.currentWeek, week.isoWeek)} <small className="muted">du {mondayLabel(week.weekStart)}</small>
            </h2>
            {items.length === 0 && <p className="muted">Aucun sujet au planning.</p>}
            <ul className="plain">
              {items.map(({ row, entry }) => (
                <li key={entry.id}>
                  <span className={`chip state-${entry.status.state}`}>{STATE_LABELS[entry.status.state]}</span>
                  {entry.status.needsAttention && <span className="badge status-erreur">À traiter</span>} <strong>{row.label}</strong> :{' '}
                  <Link href={`/planning/${workspaceId}/case?ligne=${encodeURIComponent(row.key)}&semaine=${week.weekStart}`}>{entry.content}</Link>
                  {entry.setAsideReason && <span className="muted"> · mis de côté : {entry.setAsideReason}</span>}
                  {entry.posts.map((post) => (
                    <span key={post.id} className="no-print">
                      {' · '}
                      <Link href={`/posts/${post.id}`}>Voir le post</Link> <StatusBadge status={post.status} />
                    </span>
                  ))}
                  {entry.posts.length === 0 && entry.setAsideReason === null && <span className="muted"> · pas encore de post</span>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section aria-labelledby="posts-semaine">
        <h2 id="posts-semaine">Posts de la semaine ({doc.posts.length})</h2>
        <ul className="cards">
          {doc.posts.map((post) => (
            <li key={post.id} className="card">
              <p>
                <strong>{post.accountName}</strong> · {dateTime.format(post.scheduledAt)} <StatusBadge status={post.status} />{' '}
                <span className="badge">{ORIGINS[post.origin] ?? post.origin}</span>
              </p>
              {post.subject && <p className="muted">{post.subject}</p>}
              <p className="pre week-post-body">{post.body}</p>
              <p className="no-print">
                <Link href={`/posts/${post.id}`}>Ouvrir le post</Link>
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="suivi">
        <h2 id="suivi">Suivi des 8 dernières semaines</h2>
        <p className="hint">Données de l’outil uniquement : aucune statistique LinkedIn des profils personnels.</p>
        {doc.tracking.map((account) => (
          <div key={account.accountId} className="grid-scroll" role="region" aria-label={`Suivi de ${account.accountName}`} tabIndex={0}>
            <table className="tracking">
              <caption>{account.accountName}</caption>
              <thead>
                <tr>
                  <th scope="col">Semaine</th>
                  <th scope="col">Proposés</th>
                  <th scope="col">Publiés</th>
                  <th scope="col">Validés tels quels</th>
                  <th scope="col">Modifiés</th>
                  <th scope="col">Refusés</th>
                  <th scope="col">Délai de décision (médian)</th>
                  <th scope="col">Créneaux tenus</th>
                </tr>
              </thead>
              <tbody>
                {account.weeks.map((w) => (
                  <tr key={w.weekStart}>
                    <th scope="row">S{w.isoWeek}</th>
                    <td>{w.proposed}</td>
                    <td>{w.published}</td>
                    <td>{pct(w.validatedAsIs, w.validatedAsIs + w.validatedModified)}</td>
                    <td>{w.validatedModified}</td>
                    <td>{w.refused}</td>
                    <td>{w.medianDecisionHours === null ? '–' : `${String(w.medianDecisionHours).replace('.', ',')} h`}</td>
                    <td>{pct(w.onTime, w.published)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
    </>
  );
}

import { addDays } from '@posts-auto/core';
import { NotFoundError, cellKey, planningGrid, weekDocument } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StatusBadge } from '../../../../../components/status-badge.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { PlanningBack, STATE_LABELS, mondayLabel } from '../../planning-ui.tsx';

export const metadata: Metadata = { title: 'Document de la semaine' };
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
    const grid = await planningGrid(database(), userId, workspaceId, { from: doc.weekStart, weeks: 1 }, new Date());
    data = { doc, grid };
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { doc, grid } = data;
  const rows = grid.rows.filter((row) => (grid.entries[cellKey(row.row, doc.weekStart)] ?? []).length > 0);

  return (
    <>
      <PlanningBack workspaceId={workspaceId} />
      <h1>
        {doc.workspaceName} · semaine {doc.isoWeek} <small className="muted">du {mondayLabel(doc.weekStart)}</small>
      </h1>
      <div className="toolbar split">
        <div className="segmented" role="group" aria-label="Semaine affichée">
          <Link href={`?du=${addDays(doc.weekStart, -7)}`} aria-label="Semaine précédente">
            ← Précédente
          </Link>
          <Link href={`?du=${addDays(doc.weekStart, 7)}`} aria-label="Semaine suivante">
            Suivante →
          </Link>
        </div>
        <span className="hint no-print">Pour un PDF : imprimer la page, puis « Enregistrer au format PDF ».</span>
      </div>

      <section aria-labelledby="planning-semaine">
        <h2 id="planning-semaine">Planning de la semaine</h2>
        {rows.length === 0 && <p className="muted">Aucun sujet au planning.</p>}
        <ul className="plain">
          {rows.map((row) => (
            <li key={row.key}>
              <strong>{row.label}</strong> :{' '}
              {(grid.entries[cellKey(row.row, doc.weekStart)] ?? []).map((entry, i) => (
                <span key={entry.id}>
                  {i > 0 && ' ; '}
                  {entry.content} <span className={`chip state-${entry.status.state}`}>{STATE_LABELS[entry.status.state]}</span>
                  {entry.setAsideReason && <span className="muted"> ({entry.setAsideReason})</span>}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </section>

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
              <p className="pre">{post.body}</p>
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
          <div key={account.accountId} className="grid-scroll">
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

import { addDays } from '@posts-auto/core';
import { NotFoundError, cellKey, listWorkspaceAccounts, planningGrid } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { PlanningNav, STATE_LABELS, mondayLabel } from '../planning-ui.tsx';

export const metadata: Metadata = { title: 'Planning éditorial' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEKS = 13; // un trimestre

/** PLA-01, PLA-02 : comptes × semaines, par trimestre, avec filtre par compte. */
export default async function PlanningPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message, depuis, compte } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const accountId = typeof compte === 'string' && UUID.test(compte) ? compte : undefined;
  let grid;
  try {
    grid = await planningGrid(
      database(),
      userId,
      workspaceId,
      { weeks: WEEKS, ...(typeof depuis === 'string' && { from: depuis }), ...(accountId && { accountId }) },
      new Date(),
    );
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const accounts = await listWorkspaceAccounts(database(), userId, workspaceId);
  const from = grid.weeks[0]?.weekStart ?? grid.currentWeek;
  const query = (start: string) => `?depuis=${start}${accountId ? `&compte=${accountId}` : ''}`;

  return (
    <>
      <h1>Planning éditorial</h1>
      <PlanningNav workspaceId={workspaceId} current="grille" />
      <Flash code={message} />

      <div className="toolbar">
        <Link href={query(addDays(from, -7 * WEEKS))}>← Trimestre précédent</Link>
        <Link href={query(grid.currentWeek)}>Cette semaine</Link>
        <Link href={query(addDays(from, 7 * WEEKS))}>Trimestre suivant →</Link>
        <form method="get" className="inline">
          <input type="hidden" name="depuis" value={from} />
          <label htmlFor="compte">Compte</label>
          <select id="compte" name="compte" defaultValue={accountId ?? ''}>
            <option value="">Tous</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="submit">Filtrer</button>
        </form>
      </div>

      <div className="grid-scroll" role="region" aria-label="Planning du trimestre" tabIndex={0}>
        <table className="planning">
          <thead>
            <tr>
              <th scope="col">Ligne</th>
              {grid.weeks.map((w) => (
                <th key={w.weekStart} scope="col" className={w.weekStart === grid.currentWeek ? 'current' : undefined}>
                  S{w.isoWeek}
                  <small>{mondayLabel(w.weekStart)}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  {row.label}
                  {row.row.kind !== 'account' && <small>{row.row.kind === 'event' ? 'Événements' : 'Autre canal'}</small>}
                </th>
                {grid.weeks.map((w) => {
                  const entries = grid.entries[cellKey(row.row, w.weekStart)] ?? [];
                  const href = `/planning/${workspaceId}/case?ligne=${encodeURIComponent(row.key)}&semaine=${w.weekStart}`;
                  return (
                    <td key={w.weekStart} className={w.weekStart === grid.currentWeek ? 'current' : undefined}>
                      {entries.map((entry) => (
                        <Link key={entry.id} href={href} className={`chip state-${entry.status.state}${entry.status.needsAttention ? ' attention' : ''}`}>
                          <span className="visually-hidden">{STATE_LABELS[entry.status.state]} : </span>
                          {entry.content}
                        </Link>
                      ))}
                      {entries.length === 0 && grid.canEdit && (
                        <Link href={href} className="add" aria-label={`Ajouter un sujet : ${row.label}, semaine ${w.isoWeek}`}>
                          +
                        </Link>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="legend">
        {Object.entries(STATE_LABELS).map(([state, label]) => (
          <span key={state} className={`chip state-${state}`}>
            {label}
          </span>
        ))}
      </p>

      {grid.canEdit && (
        <details>
          <summary>Ajouter une ligne d’événements ou d’un autre canal</summary>
          <form method="get" action={`/planning/${workspaceId}/case`} className="stack">
            <input type="hidden" name="semaine" value={grid.currentWeek} />
            <label htmlFor="type">Type de ligne</label>
            <select id="type" name="type" defaultValue="evenement">
              <option value="evenement">Événements (salons, webinaires, presse)</option>
              <option value="canal">Autre canal (newsletter, blog…)</option>
            </select>
            <label htmlFor="libelle">Libellé de la ligne</label>
            <input id="libelle" name="libelle" required maxLength={100} />
            <button type="submit">Continuer</button>
          </form>
        </details>
      )}
    </>
  );
}

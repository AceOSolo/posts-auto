import { addDays } from '@posts-auto/core';
import { NotFoundError, cellKey, generationStatus, listWorkspaceAccounts, planningGrid } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoSubmitSelect } from '../../../../components/auto-submit-select.tsx';
import { Flash } from '../../../../components/flash.tsx';
import { PageHeader } from '../../../../components/page-header.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { STATE_LABELS, generationSummary, mondayLabel, planningMenu } from '../planning-ui.tsx';

export const metadata: Metadata = { title: 'Planning' };
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
  const { message, depuis, compte, ajouter } = await searchParams;
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
  const [accounts, generation] = await Promise.all([listWorkspaceAccounts(database(), userId, workspaceId), generationStatus(database(), userId, workspaceId, new Date())]);
  const firstRow = grid.rows[0];
  const from = grid.weeks[0]?.weekStart ?? grid.currentWeek;
  const query = (start: string) => `?depuis=${start}${accountId ? `&compte=${accountId}` : ''}`;

  return (
    <>
      <PageHeader
        title="Planning"
        description={generationSummary(generation)}
        action={
          grid.canEdit && firstRow !== undefined ? (
            <Link href={`/planning/${workspaceId}/case?ligne=${encodeURIComponent(firstRow.key)}&semaine=${grid.currentWeek}`} className="button primary">
              Ajouter un sujet
            </Link>
          ) : undefined
        }
        menu={planningMenu(workspaceId, `/planning/${workspaceId}/export?depuis=${from}`, grid.canEdit)}
      />
      <Flash code={message} />

      <div className="toolbar split">
        <div className="segmented" role="group" aria-label="Période affichée">
          <Link href={query(addDays(from, -7 * WEEKS))} aria-label="Trimestre précédent">
            ← Précédent
          </Link>
          <Link href={query(grid.currentWeek)}>Cette semaine</Link>
          <Link href={query(addDays(from, 7 * WEEKS))} aria-label="Trimestre suivant">
            Suivant →
          </Link>
        </div>
        {accounts.length > 1 && (
          <form method="get" className="inline">
            <input type="hidden" name="depuis" value={from} />
            <label htmlFor="compte" className="visually-hidden">
              Compte affiché
            </label>
            <AutoSubmitSelect id="compte" name="compte" defaultValue={accountId ?? ''}>
              <option value="">Tous les comptes</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </AutoSubmitSelect>
            <noscript>
              <button type="submit">Filtrer</button>
            </noscript>
          </form>
        )}
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
                          <span className="chip-state">
                            {STATE_LABELS[entry.status.state]}
                            {entry.status.needsAttention && ' · à traiter'}
                          </span>
                          <span className="chip-text">{entry.content}</span>
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

      {grid.canEdit && ajouter === 'ligne' && (
        <section id="ajouter-ligne" aria-labelledby="ajouter-ligne-titre" className="card no-print">
          <h2 id="ajouter-ligne-titre">Ajouter une ligne</h2>
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
          <p>
            <Link href={`/planning/${workspaceId}`}>Annuler</Link>
          </p>
        </section>
      )}
    </>
  );
}

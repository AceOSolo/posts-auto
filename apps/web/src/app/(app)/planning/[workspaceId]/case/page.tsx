import { type RowKey, NotFoundError, getPlanningCell, parseRowKey, rowKeyToString } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { StatusBadge } from '../../../../../components/status-badge.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { addEntryAction, deleteEntryAction, setAsideAction, updateEntryAction } from '../../actions.ts';
import { STATE_LABELS, mondayLabel } from '../../planning-ui.tsx';

export const metadata: Metadata = { title: 'Case du planning' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateTime = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

function rowFrom(params: Record<string, string | string[] | undefined>): RowKey | null {
  if (typeof params['ligne'] === 'string') return parseRowKey(params['ligne']);
  const type = params['type'];
  const label = typeof params['libelle'] === 'string' ? params['libelle'].trim() : '';
  if ((type === 'evenement' || type === 'canal') && label !== '') return parseRowKey(`${type}:${label}`);
  return null;
}

/** Une case du planning : ses sujets, leur état et les posts qui en sont issus (PLA-02, PLA-07). */
export default async function PlanningCellPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const row = rowFrom(query);
  const week = typeof query['semaine'] === 'string' ? query['semaine'] : '';
  if (!UUID.test(workspaceId) || row === null) notFound();
  const userId = await requireUserId();
  let cell;
  try {
    cell = await getPlanningCell(database(), userId, workspaceId, row, week);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const rowKey = rowKeyToString(row);

  return (
    <>
      <p>
        <Link href={`/planning/${workspaceId}?depuis=${cell.weekStart}`}>← Planning</Link>
      </p>
      <h1>
        {cell.label} <small className="muted">· semaine {cell.isoWeek}, du {mondayLabel(cell.weekStart)}</small>
      </h1>
      <Flash code={query['message']} />

      {cell.entries.length === 0 && <p className="muted">Aucun sujet prévu cette semaine.</p>}
      <ul className="cards">
        {cell.entries.map((entry) => (
          <li key={entry.id} className="card">
            <p>
              <span className={`chip state-${entry.status.state}`}>{STATE_LABELS[entry.status.state]}</span>
              {entry.status.needsAttention && <span className="badge status-erreur">À traiter</span>}
            </p>
            <p>
              <strong>{entry.content}</strong>
            </p>
            {entry.setAsideReason && <p className="muted">Mis de côté : {entry.setAsideReason}</p>}
            {entry.posts.length > 0 && (
              <ul className="plain">
                {entry.posts.map((post) => (
                  <li key={post.id}>
                    <Link href={`/posts/${post.id}`}>Post du {dateTime.format(post.scheduledAt)}</Link> <StatusBadge status={post.status} />
                  </li>
                ))}
              </ul>
            )}
            {cell.canEdit && (
              <div className="stack">
                <details>
                  <summary>Modifier le sujet</summary>
                  <form action={updateEntryAction.bind(null, workspaceId, entry.id, rowKey, cell.weekStart)} className="stack">
                    <label htmlFor={`sujet-${entry.id}`}>Sujet</label>
                    <input id={`sujet-${entry.id}`} name="sujet" required maxLength={500} defaultValue={entry.content} />
                    <button type="submit">Enregistrer</button>
                  </form>
                </details>
                {entry.setAsideReason === null ? (
                  <details>
                    <summary>Mettre de côté</summary>
                    <form action={setAsideAction.bind(null, workspaceId, entry.id, rowKey, cell.weekStart)} className="stack">
                      <label htmlFor={`motif-${entry.id}`}>Pourquoi ?</label>
                      <input id={`motif-${entry.id}`} name="motif" required maxLength={500} />
                      <button type="submit">Mettre de côté</button>
                    </form>
                  </details>
                ) : (
                  <form action={setAsideAction.bind(null, workspaceId, entry.id, rowKey, cell.weekStart)}>
                    <button type="submit" name="reprendre" value="1">
                      Remettre dans le planning
                    </button>
                  </form>
                )}
                {entry.posts.length === 0 && (
                  <form action={deleteEntryAction.bind(null, workspaceId, entry.id, rowKey, cell.weekStart)}>
                    <button type="submit">Supprimer le sujet</button>
                  </form>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {cell.canEdit && (
        <section aria-labelledby="ajout">
          <h2 id="ajout">Ajouter un sujet</h2>
          <form action={addEntryAction.bind(null, workspaceId, rowKey, cell.weekStart)} className="stack">
            <label htmlFor="sujet">Sujet (texte court)</label>
            <input id="sujet" name="sujet" required maxLength={500} />
            <button type="submit" className="primary">
              Ajouter
            </button>
          </form>
        </section>
      )}
    </>
  );
}

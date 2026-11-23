import { NotFoundError, rowKeyToString, weekInventory } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StatusBadge } from '../../../../../components/status-badge.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { PlanningBack, STATE_LABELS, mondayLabel } from '../../planning-ui.tsx';

export const metadata: Metadata = { title: 'Inventaire de la semaine' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PLA-08 : sujets des semaines en cours et suivante, avec le post correspondant ou la raison de mise de côté. */
export default async function InventoryPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let inventory;
  try {
    inventory = await weekInventory(database(), userId, workspaceId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <>
      <PlanningBack workspaceId={workspaceId} />
      <h1>Inventaire de la semaine</h1>
      {inventory.weeks.map((week, index) => {
        const items = inventory.items.filter((item) => item.weekStart === week);
        return (
          <section key={week} aria-labelledby={`semaine-${week}`}>
            <h2 id={`semaine-${week}`}>
              {index === 0 ? 'Cette semaine' : 'Semaine prochaine'} <small>· du {mondayLabel(week)}</small>
            </h2>
            {items.length === 0 && <p className="muted">Aucun sujet au planning.</p>}
            <ul className="cards">
              {items.map((item) => (
                <li key={item.id} className="card">
                  <p>
                    <span className={`chip state-${item.status.state}`}>{STATE_LABELS[item.status.state]}</span>
                    {item.status.needsAttention && <span className="badge status-erreur">À traiter</span>} <strong>{item.label}</strong>
                  </p>
                  <p>
                    <Link href={`/planning/${workspaceId}/case?ligne=${encodeURIComponent(rowKeyToString(item.row))}&semaine=${item.weekStart}`}>{item.content}</Link>
                  </p>
                  {item.setAsideReason && <p className="muted">Mis de côté : {item.setAsideReason}</p>}
                  {item.posts.map((post) => (
                    <p key={post.id}>
                      <Link href={`/posts/${post.id}`}>Voir le post</Link> <StatusBadge status={post.status} />
                    </p>
                  ))}
                  {item.posts.length === 0 && item.setAsideReason === null && <p className="muted">Pas encore de post : il sera rédigé à la prochaine génération.</p>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

import { DEFAULT_WORKSPACE_CALENDAR, addMinutes, isoWeekBounds, localDate } from '@posts-auto/core';
import { listMyWorkspaces, teamWeek } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StatusBadge } from '../../../../components/status-badge.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';

export const metadata: Metadata = { title: 'Posts de la semaine' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const calendar = DEFAULT_WORKSPACE_CALENDAR;

function mondayOf(value: string | undefined, now: Date): string {
  const instant = value !== undefined && WEEK.test(value) ? new Date(`${value}T12:00:00Z`) : now;
  return localDate(isoWeekBounds(instant, calendar).start, calendar);
}

function shiftWeek(monday: string, weeks: number): string {
  return mondayOf(localDate(addMinutes(new Date(`${monday}T12:00:00Z`), weeks * 7 * 24 * 60), calendar), new Date());
}

function slot(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at);
}

/** VAL-07 : tous les posts de la semaine, par compte et par statut, pour la com'. */
export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { semaine, filtre } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const monday = mondayOf(typeof semaine === 'string' ? semaine : undefined, new Date());
  const [accounts, workspaces] = await Promise.all([teamWeek(database(), userId, workspaceId, monday, new Date()), listMyWorkspaces(database(), userId)]);
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) notFound();

  const pendingOnly = filtre === 'en-attente';
  const pending = accounts.flatMap((account) => account.posts).filter((post) => post.status === 'a_valider').length;

  return (
    <>
      <p className="back-link">
        <Link href={`/tableau/${workspaceId}`}>← Tableau de bord</Link>
      </p>
      <h1>Posts de la semaine</h1>
      <nav className="week-nav" aria-label="Semaines">
        <Link href={`?semaine=${shiftWeek(monday, -1)}`}>← Semaine précédente</Link>
        <strong>Semaine du {new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${monday}T12:00:00Z`))}</strong>
        <Link href={`?semaine=${shiftWeek(monday, 1)}`}>Semaine suivante →</Link>
      </nav>
      <p>
        {pending} post{pending > 1 ? 's' : ''} en attente de validation ·{' '}
        {pendingOnly ? <Link href={`?semaine=${monday}`}>Tout afficher</Link> : <Link href={`?semaine=${monday}&filtre=en-attente`}>Seulement en attente</Link>}
      </p>
      {accounts.length === 0 && (
        <p className="muted">
          Aucun compte LinkedIn dans cet espace pour l’instant. <Link href={`/comptes/${workspaceId}`}>Connecter un compte</Link>
        </p>
      )}
      {accounts.map((account) => {
        const posts = pendingOnly ? account.posts.filter((post) => post.status === 'a_valider') : account.posts;
        if (pendingOnly && posts.length === 0) return null;
        return (
          <section key={account.accountId} className="team-account">
            <h2>
              {account.accountName}
              {account.holderName && <small> · titulaire : {account.holderName}</small>}
            </h2>
            {posts.length === 0 ? (
              <p className="muted">Aucun post cette semaine.</p>
            ) : (
              <ul className="team-posts">
                {posts.map((post) => (
                  <li key={post.id}>
                    <span className="slot">{slot(post.scheduledAt, post.timeZone)}</span> <StatusBadge status={post.status} />{' '}
                    <Link href={`/posts/${post.id}`}>{post.body.slice(0, 80) || 'Sans texte'}…</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}

import { listMyWorkspaces, listNotifications } from '@posts-auto/services';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { database } from '../../server/context.ts';
import { requireUserId } from '../../server/session.ts';
import { logout } from '../connexion/actions.ts';

/** Pages réservées aux personnes connectées. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const userId = await requireUserId();
  const workspaces = await listMyWorkspaces(database(), userId);
  const { unread } = await listNotifications(database(), userId, 1);
  return (
    <>
      <header className="topbar">
        <nav aria-label="Navigation principale">
          <Link href="/" className="brand">
            Posts LinkedIn
          </Link>
          <Link href="/">Mes posts</Link>
          <Link href="/notifications" aria-label={`Notifications${unread > 0 ? ` : ${unread} non lue${unread > 1 ? 's' : ''}` : ''}`}>
            Notifications{unread > 0 && <span className="pill">{unread}</span>}
          </Link>
          {workspaces.map((workspace) => (
            <span key={workspace.id} className="nav-group">
              <Link href={`/equipe/${workspace.id}`}>Équipe · {workspace.name}</Link>
              <Link href={`/comptes/${workspace.id}`}>Comptes</Link>
              <Link href={`/ligne/${workspace.id}`}>Ligne éditoriale</Link>
              <Link href={`/espace/${workspace.id}`}>Réglages</Link>
            </span>
          ))}
        </nav>
        <span className="nav-group">
          <Link href="/moi">Mon compte</Link>
          <form action={logout}>
            <button type="submit" className="link">
              Déconnexion
            </button>
          </form>
        </span>
      </header>
      <main>{children}</main>
    </>
  );
}

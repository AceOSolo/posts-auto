import { listMyWorkspaces } from '@posts-auto/services';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { database } from '../../server/context.ts';
import { requireUserId } from '../../server/session.ts';
import { logout } from '../connexion/actions.ts';

/** Pages réservées aux personnes connectées. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const userId = await requireUserId();
  const workspaces = await listMyWorkspaces(database(), userId);
  return (
    <>
      <header className="topbar">
        <nav aria-label="Navigation principale">
          <Link href="/" className="brand">
            Posts LinkedIn
          </Link>
          <Link href="/">Mes posts</Link>
          {workspaces.map((workspace) => (
            <Link key={workspace.id} href={`/equipe/${workspace.id}`}>
              Équipe · {workspace.name}
            </Link>
          ))}
        </nav>
        <form action={logout}>
          <button type="submit" className="link">
            Déconnexion
          </button>
        </form>
      </header>
      <main>{children}</main>
    </>
  );
}

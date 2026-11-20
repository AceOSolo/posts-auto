import { TRIAL_MAX_ACCOUNTS, TRIAL_MAX_POSTS, listMyWorkspaces, listNotifications, trialBanners } from '@posts-auto/services';
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
  const trials = await trialBanners(database(), userId, new Date());
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
              <Link href={`/tableau/${workspace.id}`}>Tableau de bord · {workspace.name}</Link>
              <Link href={`/equipe/${workspace.id}`}>Équipe</Link>
              <Link href={`/comptes/${workspace.id}`}>Comptes</Link>
              <Link href={`/planning/${workspace.id}`}>Planning</Link>
              <Link href={`/idees/${workspace.id}`}>Idées et demandes</Link>
              <Link href={`/ligne/${workspace.id}`}>Ligne éditoriale</Link>
              <Link href={`/visuels/${workspace.id}`}>Visuels</Link>
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
      {/* ONB-06 : état de l'essai gratuit, pour qui gère l'espace. */}
      {trials.map((trial) => (
        <p key={trial.orgId} className={`trial-banner${trial.expired ? ' expired' : ''}`} role="status">
          {trial.expired ? (
            <>
              <strong>Essai gratuit terminé</strong> : la rédaction par l’IA est en pause ; les posts déjà validés partent toujours.
            </>
          ) : (
            <>
              <strong>Essai gratuit</strong> · {trial.daysLeft} jour{trial.daysLeft > 1 ? 's' : ''} restant{trial.daysLeft > 1 ? 's' : ''} · {trial.posts} post
              {trial.posts > 1 ? 's' : ''} rédigé{trial.posts > 1 ? 's' : ''} sur {TRIAL_MAX_POSTS} · {trial.accounts} compte{trial.accounts > 1 ? 's' : ''} LinkedIn sur{' '}
              {TRIAL_MAX_ACCOUNTS}
            </>
          )}
        </p>
      ))}
      <main>{children}</main>
    </>
  );
}

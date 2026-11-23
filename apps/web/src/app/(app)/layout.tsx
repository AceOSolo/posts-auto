import { TRIAL_MAX_ACCOUNTS, TRIAL_MAX_POSTS, activeAnnouncements, countPostsToValidate, isPlatformAdmin, listMyWorkspaces, listNotifications, mfaStatus, ownedOrganizations, trialBanners } from '@posts-auto/services';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Reminder } from '../../components/app-nav-model.ts';
import { AppNav } from '../../components/app-nav.tsx';
import { Logo } from '../../components/logo.tsx';
import { database } from '../../server/context.ts';
import { currentSession, requireUserId } from '../../server/session.ts';
import { logout } from '../connexion/actions.ts';
import { OnboardingReturnBar } from './demarrage/return-bar.tsx';

/** Pages réservées aux personnes connectées. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const userId = await requireUserId();
  const workspaces = await listMyWorkspaces(database(), userId);
  const { unread } = await listNotifications(database(), userId, 1);
  const toValidate = await countPostsToValidate(database(), userId, new Date());
  const trials = await trialBanners(database(), userId, new Date());
  const owned = await ownedOrganizations(database(), userId);
  const mfa = await mfaStatus(database(), userId, new Date());
  const platformAdmin = await isPlatformAdmin(database(), userId);
  const announcements = await activeAnnouncements(database(), new Date());
  const support = (await currentSession())?.supportAdminId ?? null;
  const rememberedWorkspace = (await cookies()).get('rostra_espace')?.value;
  const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

  // Ce qui peut attendre va dans « À faire » : annonces, essai en cours (ONB-06), double authentification (SEC-04).
  const reminders: Reminder[] = [
    ...(mfa.deadline !== null && !mfa.overdue
      ? [
          {
            key: 'mfa',
            title: 'Double authentification',
            detail: `Obligatoire pour votre rôle, à activer avant le ${new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long' }).format(mfa.deadline)}.`,
            href: '/securite',
            cta: 'L’activer',
          },
        ]
      : []),
    ...trials
      .filter((trial) => !trial.expired)
      .map((trial) => ({
        key: `essai-${trial.orgId}`,
        title: `Essai gratuit : ${plural(trial.daysLeft, 'jour')} restant${trial.daysLeft > 1 ? 's' : ''}`,
        detail: `${plural(trial.posts, 'post')} sur ${TRIAL_MAX_POSTS}, ${plural(trial.accounts, 'compte')} LinkedIn sur ${TRIAL_MAX_ACCOUNTS}.`,
        href: `/abonnement/${trial.workspaceId}`,
        cta: trial.canSubscribe ? 'Souscrire' : 'Voir les formules',
      })),
    ...announcements
      .filter((a) => a.level !== 'maintenance')
      .map((a) => ({ key: `annonce-${a.id}`, title: 'Nouveau', detail: a.message, href: null, cta: null })),
  ];
  const maintenance = announcements.filter((a) => a.level === 'maintenance');
  const expiredTrials = trials.filter((trial) => trial.expired);
  const hasNotices = support !== null || maintenance.length > 0 || expiredTrials.length > 0;

  return (
    <div className="app-shell">
      <AppNav
        brand={<Logo title="Rostra" />}
        workspaces={workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
        initialWorkspaceId={workspaces.find((workspace) => workspace.id === rememberedWorkspace)?.id ?? workspaces[0]?.id ?? null}
        owned={owned.map((org) => ({ label: org.kind === 'agence' ? 'Clients' : 'Espaces', workspaceId: org.workspaceId }))}
        platformAdmin={platformAdmin}
        unread={unread}
        toValidate={toValidate}
        reminders={reminders}
        logoutAction={logout}
      />
      <div className="app-content">
        {/* Seul ce qui change ce qui se passe maintenant reste affiché au-dessus de la page. */}
        {hasNotices && (
          <div className="app-notices">
            {/* ADM-02 : session ouverte par le support, avec l'accord du client. */}
            {support !== null && (
              <p className="notice" role="status">
                <span>
                  <strong>Session du support</strong> : ouverte avec votre accord, inscrite au journal d’audit. Elle se termine à la déconnexion ou à la fin de l’accord.
                </span>
              </p>
            )}
            {/* ADM-06 : maintenance annoncée par l'éditeur. */}
            {maintenance.map((a) => (
              <p key={a.id} className="notice" role="status">
                <span>
                  <strong>Maintenance</strong> : {a.message}
                </span>
              </p>
            ))}
            {/* ONB-06 : essai terminé, la rédaction est arrêtée. */}
            {expiredTrials.map((trial) => (
              <p key={trial.orgId} className="notice" role="status">
                <span>
                  <strong>Essai gratuit terminé</strong> : la rédaction par l’IA est en pause ; les posts déjà validés partent toujours.
                </span>
                <Link href={`/abonnement/${trial.workspaceId}`}>{trial.canSubscribe ? 'Choisir une formule' : 'Voir l’abonnement'}</Link>
              </p>
            ))}
          </div>
        )}
        <main>
          <OnboardingReturnBar />
          {children}
        </main>
      </div>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type NavContext, type NavSection, type NavTab, type Reminder, type SectionId, buildSections, locate, workspaceInPath } from './app-nav-model.ts';

/** Dernier espace ouvert, relu par le layout pour le retrouver au prochain chargement. */
const WORKSPACE_COOKIE = 'rostra_espace';

const ICONS: Record<SectionId, ReactNode> = {
  valider: <path d="M20 6 9 17l-5-5" />,
  creer: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  equipe: <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />,
  parametres: <path d="M4 7h10M18 7h2M4 17h2M10 17h10M16 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />,
  compte: <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />,
};

interface AppNavProps {
  readonly brand: ReactNode;
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
  readonly initialWorkspaceId: string | null;
  readonly owned: NavContext['owned'];
  readonly platformAdmin: boolean;
  readonly unread: number;
  /** Posts qui attendent la décision de la personne. */
  readonly toValidate: number;
  readonly reminders: readonly Reminder[];
  readonly logoutAction: () => Promise<void>;
}

/**
 * Le seul menu de l'application : cinq rubriques, les pages de la rubrique ouverte juste dessous.
 * Sur téléphone, les rubriques passent en barre fixe et leurs pages en onglets sous le logo.
 */
export function AppNav({ brand, workspaces, initialWorkspaceId, owned, platformAdmin, unread, toValidate, reminders, logoutAction }: AppNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const workspaceIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const tabsRef = useRef<HTMLElement>(null);
  const [remembered, setRemembered] = useState(initialWorkspaceId);
  const inPath = workspaceInPath(pathname, workspaceIds);
  if (inPath !== null && inPath !== remembered) setRemembered(inPath);
  const workspaceId = inPath ?? remembered;

  useEffect(() => {
    if (workspaceId === null) return;
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${WORKSPACE_COOKIE}=${workspaceId}; path=/; max-age=31536000; samesite=lax${secure}`;
  }, [workspaceId]);

  // Sur téléphone, les onglets défilent : l'onglet ouvert doit rester visible.
  useEffect(() => {
    tabsRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);

  const sections = buildSections({ workspaceId, owned, platformAdmin });
  const { section: current, tab: currentTab } = locate(sections, pathname);
  const badges: Partial<Record<SectionId, { readonly count: number; readonly label: string }>> = {
    valider: { count: toValidate, label: `${toValidate} post${toValidate > 1 ? 's' : ''} à valider` },
    compte: { count: unread, label: `${unread} notification${unread > 1 ? 's' : ''} non lue${unread > 1 ? 's' : ''}` },
  };

  function switchWorkspace(nextId: string) {
    setRemembered(nextId);
    if (inPath === null || current === null || currentTab === null) return;
    const nextSections = buildSections({ workspaceId: nextId, owned, platformAdmin });
    const nextSection = nextSections.find((s) => s.id === current.id);
    const nextTab = nextSection?.tabs.find((t) => t.label === currentTab.label);
    router.push(nextTab?.href ?? nextSection?.href ?? '/');
  }

  const tabLinks = (section: NavSection, wrap: (tab: NavTab, link: ReactNode) => ReactNode) =>
    section.tabs.map((tab) =>
      wrap(
        tab,
        <Link key={tab.href} href={tab.href} aria-current={currentTab?.href === tab.href ? 'page' : undefined}>
          {tab.label}
          {tab.href === '/notifications' && unread > 0 && <span className="nav-dot">{unread}</span>}
        </Link>,
      ),
    );
  const logoutForm = (
    <form action={logoutAction}>
      <button type="submit" className="link">
        Déconnexion
      </button>
    </form>
  );

  return (
    <header className="app-side">
      <Link href="/" className="brand" aria-label="Rostra, mes posts">
        {brand}
      </Link>

      {workspaces.length > 1 && workspaceId !== null && (
        <div className="workspace-switch">
          <label htmlFor="espace-courant" className="visually-hidden">
            Espace de travail
          </label>
          <select id="espace-courant" value={workspaceId} onChange={(event) => switchWorkspace(event.target.value)}>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <nav aria-label="Navigation principale" className="side-nav">
        <ul>
          {sections.map((section) => {
            const active = current?.id === section.id;
            const hasPages = section.tabs.length > 1;
            const badge = badges[section.id];
            const showBadge = badge !== undefined && badge.count > 0;
            return (
              <li key={section.id}>
                <Link
                  href={section.href}
                  className="side-link"
                  aria-current={active ? (hasPages ? 'true' : 'page') : undefined}
                  aria-label={showBadge ? `${section.label} : ${badge.label}` : undefined}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {ICONS[section.id]}
                  </svg>
                  <span>{section.label}</span>
                  {showBadge && <span className="nav-dot">{badge.count}</span>}
                </Link>
                {active && hasPages && (
                  <ul className="side-sub">
                    {tabLinks(section, (tab, link) => (
                      <li key={tab.href}>{link}</li>
                    ))}
                    {section.id === 'compte' && <li>{logoutForm}</li>}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {current !== null && current.tabs.length > 1 && (
        <nav ref={tabsRef} aria-label={current.label} className="mobile-tabs">
          {tabLinks(current, (_tab, link) => link)}
          {current.id === 'compte' && logoutForm}
        </nav>
      )}

      {reminders.length > 0 && (
        <details key={pathname} className="reminders">
          <summary>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 8v4M12 16h.01" />
            </svg>
            <span>À faire</span>
            <span className="nav-dot">{reminders.length}</span>
          </summary>
          <ul>
            {reminders.map((reminder) => (
              <li key={reminder.key}>
                <strong>{reminder.title}</strong>
                <span>{reminder.detail}</span>
                {reminder.href !== null && <Link href={reminder.href}>{reminder.cta}</Link>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </header>
  );
}

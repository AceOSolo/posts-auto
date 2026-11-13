import type { CellState } from '@posts-auto/core';
import Link from 'next/link';

export const STATE_LABELS: Record<CellState, string> = {
  planned: 'Prévu',
  drafted: 'Rédigé',
  validated: 'Validé',
  published: 'Publié',
  set_aside: 'Mis de côté',
};

const shortDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** « 16 nov. » pour un lundi AAAA-MM-JJ (date civile, sans fuseau). */
export function mondayLabel(weekStart: string): string {
  return shortDate.format(new Date(`${weekStart}T00:00:00Z`));
}

/** Sous-navigation du planning, commune à ses pages. */
export function PlanningNav({ workspaceId, current }: { workspaceId: string; current: 'grille' | 'banque' | 'evenements' | 'inventaire' | 'import' }) {
  const links = [
    ['grille', `/planning/${workspaceId}`, 'Planning'],
    ['inventaire', `/planning/${workspaceId}/inventaire`, 'Inventaire de la semaine'],
    ['banque', `/planning/${workspaceId}/banque`, 'Banque de sujets'],
    ['evenements', `/planning/${workspaceId}/evenements`, 'Événements'],
    ['import', `/planning/${workspaceId}/import`, 'Importer'],
  ] as const;
  return (
    <nav aria-label="Planning" className="subnav">
      {links.map(([key, href, label]) => (
        <Link key={key} href={href} aria-current={key === current ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

import type { CellState } from '@posts-auto/core';
import Link from 'next/link';
import type { PageMenuItem } from '../../../components/page-header.tsx';

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

/** Retour à la grille, pour les pages d'outils du planning. */
export function PlanningBack({ workspaceId }: { workspaceId: string }) {
  return (
    <p className="back-link no-print">
      <Link href={`/planning/${workspaceId}`}>← Planning</Link>
    </p>
  );
}

/** Les outils du planning, repliés dans l'en-tête de la page. */
export function planningMenu(workspaceId: string, exportHref: string): PageMenuItem[] {
  return [
    { label: 'Banque de sujets', href: `/planning/${workspaceId}/banque` },
    { label: 'Événements', href: `/planning/${workspaceId}/evenements` },
    { label: 'Inventaire de la semaine', href: `/planning/${workspaceId}/inventaire` },
    { label: 'Document de la semaine', href: `/planning/${workspaceId}/semaine` },
    { label: 'Importer', href: `/planning/${workspaceId}/import` },
    { label: 'Exporter en CSV', href: exportHref, download: true },
  ];
}

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

/** Retour à la grille, pour les pages d'outils du planning. */
export function PlanningBack({ workspaceId }: { workspaceId: string }) {
  return (
    <p className="back-link no-print">
      <Link href={`/planning/${workspaceId}`}>← Planning</Link>
    </p>
  );
}

/** Les outils du planning, repliés dans un seul bouton à côté du titre. */
export function PlanningTools({ workspaceId, exportHref }: { workspaceId: string; exportHref: string }) {
  return (
    <details className="page-menu no-print">
      <summary>Outils</summary>
      <div className="page-menu-panel">
        <Link href={`/planning/${workspaceId}/banque`}>Banque de sujets</Link>
        <Link href={`/planning/${workspaceId}/evenements`}>Événements</Link>
        <Link href={`/planning/${workspaceId}/inventaire`}>Inventaire de la semaine</Link>
        <Link href={`/planning/${workspaceId}/semaine`}>Document de la semaine</Link>
        <Link href={`/planning/${workspaceId}/import`}>Importer</Link>
        <a href={exportHref} download>
          Exporter en CSV
        </a>
      </div>
    </details>
  );
}

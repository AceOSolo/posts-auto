import { type CellState, parseCron } from '@posts-auto/core';
import type { GenerationStatus } from '@posts-auto/services';
import Link from 'next/link';
import type { PageMenuItem } from '../../../components/page-header.tsx';

export const STATE_LABELS: Record<CellState, string> = {
  planned: 'Prévu',
  drafted: 'Rédigé',
  validated: 'Validé',
  published: 'Publié',
  set_aside: 'Mis de côté',
};

export const WEEKDAYS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

const shortDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** « 16 nov. » pour un lundi AAAA-MM-JJ (date civile, sans fuseau). */
export function mondayLabel(weekStart: string): string {
  return shortDate.format(new Date(`${weekStart}T00:00:00Z`));
}

/** Le jour et l'heure de la rédaction automatique, lus dans sa programmation. */
export function generationSchedule(cron: string): { readonly parsed: boolean; readonly day: number; readonly time: string } {
  const schedule = parseCron(cron);
  const day = schedule && schedule.daysOfWeek.size === 1 ? ([...schedule.daysOfWeek][0] ?? 1) : 1;
  const hour = schedule && schedule.hours.size === 1 ? [...schedule.hours][0] : 7;
  const minute = schedule && schedule.minutes.size === 1 ? [...schedule.minutes][0] : 30;
  return { parsed: schedule !== null, day, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

/** Où en est la rédaction, en une phrase, en tête du planning. */
export function generationSummary(status: GenerationStatus): string {
  if (status.running) return 'Une rédaction est en cours : les posts arrivent au fil de l’eau.';
  if (status.requestedAt !== null) return 'Rédaction demandée : elle démarre dans les 5 minutes.';
  const { parsed, day, time } = generationSchedule(status.cron);
  if (!status.autoGeneration || !parsed) return 'La rédaction automatique est désactivée.';
  return `Vos prochains posts seront rédigés ${WEEKDAYS[day]} à ${time.replace(':', 'h').replace(/^0/, '')}.`;
}

/** Retour à la grille, pour les pages d'outils du planning. */
export function PlanningBack({ workspaceId }: { workspaceId: string }) {
  return (
    <p className="back-link no-print">
      <Link href={`/planning/${workspaceId}`}>← Planning</Link>
    </p>
  );
}

/** Retour aux idées, pour les autres sources de sujets. */
export function IdeasBack({ workspaceId }: { workspaceId: string }) {
  return (
    <p className="back-link no-print">
      <Link href={`/idees/${workspaceId}`}>← Idées</Link>
    </p>
  );
}

/** Les usages rares du planning, repliés dans l'en-tête de la page. */
export function planningMenu(workspaceId: string, exportHref: string, canEdit: boolean): PageMenuItem[] {
  return [
    { label: 'Vue de la semaine', href: `/planning/${workspaceId}/semaine` },
    ...(canEdit ? [{ label: 'Ajouter une ligne', href: `/planning/${workspaceId}?ajouter=ligne#ajouter-ligne` }] : []),
    { label: 'Importer', href: `/planning/${workspaceId}/import` },
    { label: 'Exporter en CSV', href: exportHref, download: true },
  ];
}

/** Les autres sources de sujets, repliées dans l'en-tête de la page Idées. */
export function ideasMenu(workspaceId: string): PageMenuItem[] {
  return [
    { label: 'Demandes de post', href: `/demandes/${workspaceId}` },
    { label: 'Événements', href: `/planning/${workspaceId}/evenements` },
    { label: 'Banque de sujets', href: `/planning/${workspaceId}/banque` },
  ];
}

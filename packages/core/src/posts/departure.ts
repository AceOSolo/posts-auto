/**
 * VAL-04 : à chaque écran, une phrase claire sur le départ du post.
 * Exemples du cahier : « Part demain à 12h », « Partira en retard à 16h »,
 * « Replanifié : créneau de mardi manqué ».
 */
import { DateTime } from 'luxon';
import type { PostStatus } from './status.js';

export interface DepartureInput {
  readonly status: PostStatus;
  readonly scheduledAt: Date;
  readonly originalScheduledAt?: Date | null;
  readonly rescheduleCount?: number;
  readonly publishedAt?: Date | null;
}

/** « 12h », « 12h30 ». */
function hour(local: DateTime): string {
  return local.minute === 0 ? `${local.hour}h` : `${local.hour}h${String(local.minute).padStart(2, '0')}`;
}

/** « aujourd'hui », « demain », « jeudi », « lundi 30 novembre ». */
function day(local: DateTime, now: DateTime): string {
  const days = Math.round(local.startOf('day').diff(now.startOf('day'), 'days').days);
  if (days === 0) return 'aujourd’hui';
  if (days === 1) return 'demain';
  if (days === -1) return 'hier';
  const weekday = local.setLocale('fr').toFormat('cccc');
  if (days > 1 && days < 7) return weekday;
  return `${weekday} ${local.day} ${local.setLocale('fr').toFormat('LLLL')}`;
}

function when(at: Date, now: DateTime, timeZone: string): string {
  const local = DateTime.fromJSDate(at, { zone: timeZone });
  return `${day(local, now)} à ${hour(local)}`;
}

export function departureSentence(post: DepartureInput, nowInstant: Date, timeZone: string): string {
  const now = DateTime.fromJSDate(nowInstant, { zone: timeZone });
  let missed = '';
  if ((post.rescheduleCount ?? 0) > 0 && post.originalScheduledAt != null) {
    const original = DateTime.fromJSDate(post.originalScheduledAt, { zone: timeZone });
    missed = `Replanifié : créneau de ${original.setLocale('fr').toFormat('cccc')} ${hour(original)} manqué. `;
  }

  switch (post.status) {
    case 'publie':
      return post.publishedAt ? `Publié ${when(post.publishedAt, now, timeZone)}` : 'Publié';
    case 'en_publication':
      return 'Envoi à LinkedIn en cours';
    case 'erreur':
      return 'Erreur de publication : voir le détail';
    case 'modif':
      return 'Modification demandée : nouvelle version en préparation';
    case 'refuse':
      return 'Refusé : un autre sujet va être proposé';
    case 'remplace':
      return 'Remplacé par une nouvelle version';
    case 'abandonne':
      return 'Sorti du circuit';
    case 'brouillon':
      return 'En préparation';
    case 'valide':
      if (post.scheduledAt.getTime() <= nowInstant.getTime()) return `${missed}Part dans quelques minutes`;
      return `${missed}Part ${when(post.scheduledAt, now, timeZone)}`;
    case 'a_valider':
      if (post.scheduledAt.getTime() <= nowInstant.getTime()) {
        return `Créneau ${when(post.scheduledAt, now, timeZone)} passé : partira dès validation, sinon sera replanifié`;
      }
      return `${missed}Partira ${when(post.scheduledAt, now, timeZone)} si validé`;
  }
}

/**
 * Replanification automatique d'un post « à valider » dont le créneau est passé
 * (cahier des charges, RÈG-08 à RÈG-11).
 *
 * Règle retenue au cadrage (13/11/2026), qui remplace le « +1 heure » de la v1.1 :
 * le post est décalé **au jour autorisé suivant, à la même heure locale**. Une
 * personne peut ensuite changer ce créneau à la main (RÈG-04) ; ce changement ne
 * compte pas comme une replanification.
 *
 * Précisions :
 * - jour suivant férié ou hors plages (week-end) : jour autorisé suivant, y compris
 *   la semaine suivante (RÈG-09) ;
 * - heure d'origine déjà prise ce jour-là : heure autorisée et libre la plus proche ;
 *   à égalité, la plus tardive (le titulaire a plus de temps pour valider) ;
 * - heure d'origine hors des plages (créneau choisi à la main, ex. 20h00) : heure
 *   autorisée la plus proche ce jour-là (ici 18h00) ;
 * - jamais moins d'une heure après maintenant (RÈG-08), au cas où la tâche aurait pris
 *   du retard ;
 * - au-delà de 5 replanifications : abandon (RÈG-10) ; jamais après l'événement (RÈG-11).
 */
import { DateTime } from 'luxon';
import {
  addMinutes,
  allowedSlots,
  isWithinAllowedHours,
  sameIsoWeek,
  toLocal,
} from '../calendar/workspace-calendar.js';
import { type SchedulablePost, type SlotContext, isSlotFree } from './slots.js';

/** RÈG-10 : au-delà de 5 replanifications, le post est abandonné. */
export const MAX_AUTO_RESCHEDULES = 5;
/** RÈG-08 : un nouveau créneau est au moins à 1 heure de maintenant. */
export const RESCHEDULE_MIN_LEAD_MINUTES = 60;
/** Nombre de jours examinés avant de conclure qu'aucun créneau n'existe. */
export const RESCHEDULE_SEARCH_DAYS = 28;

export interface MissedPost extends SchedulablePost {
  /** Nombre de replanifications automatiques déjà faites (`posts.reschedule_count`). */
  readonly rescheduleCount: number;
  /** Créneau d'origine (`posts.original_scheduled_at`) : son heure locale sert de référence. */
  readonly originalScheduledAt?: Date;
}

export type RescheduleDecision =
  /** Le créneau n'est pas encore passé : rien à faire. */
  | { readonly kind: 'not_missed' }
  | {
      readonly kind: 'move';
      readonly at: Date;
      /** Nouvelle valeur de `reschedule_count`. */
      readonly rescheduleCount: number;
      /** Valeur de `original_scheduled_at` à enregistrer (inchangée si déjà connue). */
      readonly originalScheduledAt: Date;
      /** Le post change de semaine (RÈG-09) : utile au message « replanifié la semaine prochaine ». */
      readonly movedToAnotherWeek: boolean;
    }
  | {
      readonly kind: 'abandon';
      readonly reason: 'trop_de_replanifications' | 'evenement_passe' | 'plus_de_creneau';
    };

function minutesOfLocal(local: DateTime): number {
  return local.hour * 60 + local.minute;
}

/**
 * Candidats d'un jour, du plus proche au plus éloigné de l'heure de référence :
 * l'heure de référence elle-même si elle est autorisée, puis les créneaux de la grille.
 */
function candidatesOfDay(day: DateTime, referenceMinutes: number, context: SlotContext): Date[] {
  const start = day.startOf('day').toJSDate();
  const end = day.plus({ days: 1 }).startOf('day').toJSDate();
  const grid = [...allowedSlots(start, end, context.calendar)];

  const exact = DateTime.fromObject(
    { year: day.year, month: day.month, day: day.day, hour: Math.floor(referenceMinutes / 60), minute: referenceMinutes % 60 },
    { zone: context.calendar.timeZone },
  );
  const candidates = [...grid];
  if (
    exact.isValid &&
    minutesOfLocal(exact) === referenceMinutes &&
    isWithinAllowedHours(exact.toJSDate(), context.calendar) &&
    !grid.some((slot) => slot.getTime() === exact.toMillis())
  ) {
    candidates.push(exact.toJSDate());
  }

  const distance = (slot: Date) => Math.abs(minutesOfLocal(toLocal(slot, context.calendar)) - referenceMinutes);
  return candidates.sort((a, b) => distance(a) - distance(b) || b.getTime() - a.getTime());
}

export function rescheduleMissedPost(post: MissedPost, now: Date, context: SlotContext): RescheduleDecision {
  if (post.scheduledAt.getTime() > now.getTime()) return { kind: 'not_missed' };
  if (post.rescheduleCount >= MAX_AUTO_RESCHEDULES) return { kind: 'abandon', reason: 'trop_de_replanifications' };
  if (post.mustPublishBy !== undefined && now.getTime() > post.mustPublishBy.getTime()) {
    return { kind: 'abandon', reason: 'evenement_passe' };
  }

  const original = post.originalScheduledAt ?? post.scheduledAt;
  const referenceMinutes = minutesOfLocal(toLocal(original, context.calendar));
  const earliest = addMinutes(now, RESCHEDULE_MIN_LEAD_MINUTES).getTime();

  let day = toLocal(post.scheduledAt, context.calendar).startOf('day').plus({ days: 1 });
  for (let i = 0; i < RESCHEDULE_SEARCH_DAYS; i += 1, day = day.plus({ days: 1 })) {
    const choice = candidatesOfDay(day, referenceMinutes, context).find(
      (slot) => slot.getTime() >= earliest && isSlotFree(slot, post.accountId, context, post.postId),
    );
    if (choice === undefined) continue;

    if (post.mustPublishBy !== undefined && choice.getTime() > post.mustPublishBy.getTime()) {
      return { kind: 'abandon', reason: 'evenement_passe' };
    }
    return {
      kind: 'move',
      at: choice,
      rescheduleCount: post.rescheduleCount + 1,
      originalScheduledAt: original,
      movedToAnotherWeek: !sameIsoWeek(post.scheduledAt, choice, context.calendar),
    };
  }
  return { kind: 'abandon', reason: 'plus_de_creneau' };
}

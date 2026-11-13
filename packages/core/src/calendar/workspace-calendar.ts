/**
 * Calendrier d'un espace : fuseau, plages autorisées, jours fériés, pas de la grille
 * des créneaux (cahier des charges, RÈG-01 et RÈG-02).
 *
 * Principe : les heures « métier » (mardi 12h00, plage 8h00-18h00) sont exprimées en
 * heure locale de l'espace, et seuls les instants précis sont manipulés en UTC
 * (objets `Date`). Ainsi « mardi 12h00 » reste 12h00 en été comme en hiver.
 * Rien ici ne dépend du fuseau de la machine qui exécute le code.
 */
import { DateTime } from 'luxon';
import { type HolidayCalendarId, isHoliday } from './holidays.ts';

/** 1 = lundi … 7 = dimanche (norme ISO 8601). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Plage horaire locale, bornes incluses : « 08:00 »–« 18:00 » autorise un créneau à 18h00. */
export interface TimeRange {
  readonly start: string;
  readonly end: string;
}

export interface WorkspaceCalendar {
  /** Fuseau IANA de l'espace (Europe/Paris par défaut). */
  readonly timeZone: string;
  /** Plages autorisées par jour de la semaine ; un jour absent n'est pas autorisé. */
  readonly allowedHours: Readonly<Partial<Record<IsoWeekday, readonly TimeRange[]>>>;
  readonly holidays: HolidayCalendarId;
  /** Pas de la grille des créneaux candidats, en minutes, à partir du début de chaque plage. */
  readonly slotStepMinutes: number;
}

/** Créneau habituel d'un compte (EDI-04), en heure locale de l'espace. */
export interface UsualSlot {
  readonly weekday: IsoWeekday;
  readonly time: string;
}

const WORKING_DAY: readonly TimeRange[] = [{ start: '08:00', end: '18:00' }];

/** Valeurs par défaut du cahier : jours ouvrés, 8h00-18h00, fériés français, Europe/Paris. */
export const DEFAULT_WORKSPACE_CALENDAR: WorkspaceCalendar = {
  timeZone: 'Europe/Paris',
  allowedHours: { 1: WORKING_DAY, 2: WORKING_DAY, 3: WORKING_DAY, 4: WORKING_DAY, 5: WORKING_DAY },
  holidays: 'FR',
  slotStepMinutes: 30,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** « 12:30 » → 750. Lève une erreur sur un format invalide : c'est une erreur de configuration. */
export function minutesOfDay(time: string): number {
  const match = TIME_PATTERN.exec(time);
  if (match === null) throw new Error(`Heure invalide « ${time} » (format attendu HH:mm)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function toLocal(instant: Date, calendar: WorkspaceCalendar): DateTime {
  return DateTime.fromJSDate(instant, { zone: calendar.timeZone });
}

/** Date civile locale (AAAA-MM-JJ) d'un instant, dans le fuseau de l'espace. */
export function localDate(instant: Date, calendar: WorkspaceCalendar): string {
  return toLocal(instant, calendar).toISODate() ?? '';
}

/** Début du mois civil (1er à minuit, heure locale) qui contient l'instant, dans le fuseau de l'espace. */
export function startOfLocalMonth(instant: Date, calendar: WorkspaceCalendar): Date {
  return toLocal(instant, calendar).startOf('month').toJSDate();
}

/**
 * Instant correspondant à une heure locale donnée un jour donné, ou `null` si cette
 * heure n'existe pas ce jour-là (passage à l'heure d'été : 2h30 n'existe pas).
 */
function atLocalMinutes(day: DateTime, minutes: number, calendar: WorkspaceCalendar): Date | null {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const local = DateTime.fromObject(
    { year: day.year, month: day.month, day: day.day, hour, minute },
    { zone: calendar.timeZone },
  );
  if (!local.isValid || local.hour !== hour || local.minute !== minute) return null;
  return local.toJSDate();
}

/** Instant d'une date et d'une heure locales (« 2026-11-17 », « 12:00 »), ou `null` si elle n'existe pas. */
export function atLocal(date: string, time: string, calendar: WorkspaceCalendar): Date | null {
  const day = DateTime.fromISO(date, { zone: calendar.timeZone });
  if (!day.isValid) throw new Error(`Date invalide « ${date} » (format attendu AAAA-MM-JJ)`);
  return atLocalMinutes(day, minutesOfDay(time), calendar);
}

function rangesOf(calendar: WorkspaceCalendar, weekday: number): readonly TimeRange[] {
  const ranges = calendar.allowedHours[weekday as IsoWeekday] ?? [];
  return [...ranges].sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start));
}

/** L'instant tombe-t-il dans une plage autorisée, hors jour férié ? */
export function isWithinAllowedHours(instant: Date, calendar: WorkspaceCalendar): boolean {
  const local = toLocal(instant, calendar);
  if (isHoliday(calendar.holidays, local.toISODate() ?? '')) return false;
  const minutes = local.hour * 60 + local.minute + local.second / 60 + local.millisecond / 60_000;
  return rangesOf(calendar, local.weekday).some(
    (range) => minutes >= minutesOfDay(range.start) && minutes <= minutesOfDay(range.end),
  );
}

/** Début (lundi 0h00 local) et fin exclusive (lundi suivant 0h00 local) de la semaine ISO de l'instant. */
export function isoWeekBounds(instant: Date, calendar: WorkspaceCalendar): { start: Date; end: Date } {
  const start = toLocal(instant, calendar).startOf('week');
  return { start: start.toJSDate(), end: start.plus({ weeks: 1 }).toJSDate() };
}

export function sameIsoWeek(a: Date, b: Date, calendar: WorkspaceCalendar): boolean {
  return isoWeekBounds(a, calendar).start.getTime() === isoWeekBounds(b, calendar).start.getTime();
}

/**
 * Créneaux candidats de la grille, dans l'ordre chronologique, compris dans [from, until[ :
 * plages autorisées, hors jours fériés, par pas de `slotStepMinutes` depuis le début de
 * chaque plage. Les heures qui n'existent pas (passage à l'heure d'été) sont sautées.
 */
export function* allowedSlots(from: Date, until: Date, calendar: WorkspaceCalendar): Generator<Date> {
  if (calendar.slotStepMinutes <= 0) throw new Error('slotStepMinutes doit être strictement positif');
  if (until.getTime() <= from.getTime()) return;

  let day = toLocal(from, calendar).startOf('day');
  const lastDay = toLocal(until, calendar).startOf('day');
  let lastYielded = Number.NEGATIVE_INFINITY;

  while (day.toMillis() <= lastDay.toMillis()) {
    if (!isHoliday(calendar.holidays, day.toISODate() ?? '')) {
      for (const range of rangesOf(calendar, day.weekday)) {
        const end = minutesOfDay(range.end);
        for (let minutes = minutesOfDay(range.start); minutes <= end; minutes += calendar.slotStepMinutes) {
          const instant = atLocalMinutes(day, minutes, calendar);
          if (instant === null) continue;
          const t = instant.getTime();
          // Les plages qui se chevauchent ne produisent pas deux fois le même créneau.
          if (t >= from.getTime() && t < until.getTime() && t > lastYielded) {
            lastYielded = t;
            yield instant;
          }
        }
      }
    }
    day = day.plus({ days: 1 });
  }
}

/** Instants des créneaux habituels d'un compte pour la semaine ISO qui contient `weekOf`. */
export function usualSlotsInWeek(
  weekOf: Date,
  slots: readonly UsualSlot[],
  calendar: WorkspaceCalendar,
): Date[] {
  const monday = toLocal(weekOf, calendar).startOf('week');
  return slots
    .map((slot) => atLocalMinutes(monday.plus({ days: slot.weekday - 1 }), minutesOfDay(slot.time), calendar))
    .filter((instant): instant is Date => instant !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

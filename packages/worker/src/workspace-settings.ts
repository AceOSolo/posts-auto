/**
 * Réglages d'un espace lus en base, convertis vers les types du moteur de règles.
 * Les plages horaires sont stockées en JSON : elles sont validées ici, et une erreur de
 * configuration est signalée clairement plutôt que de produire des créneaux faux.
 */
import {
  type HolidayCalendarId,
  type IsoWeekday,
  type SlotRules,
  type TimeRange,
  type WorkspaceCalendar,
  isoWeekBounds,
  localDate,
  minutesOfDay,
} from '@posts-auto/core';

export interface WorkspaceSettingsRow {
  readonly timezone: string;
  readonly allowed_hours: unknown;
  readonly holidays_calendar: string;
  readonly slot_step_minutes: number;
  readonly max_posts_per_account_per_day: number;
  readonly min_gap_minutes: number;
  readonly max_posts_per_slot: number;
}

const HOLIDAY_CALENDARS: readonly HolidayCalendarId[] = ['FR', 'FR-alsace-moselle', 'none'];

function parseAllowedHours(raw: unknown): WorkspaceCalendar['allowedHours'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('allowed_hours : objet attendu');
  const result: Partial<Record<IsoWeekday, readonly TimeRange[]>> = {};
  for (const [day, ranges] of Object.entries(raw)) {
    const weekday = Number(day);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error(`allowed_hours : jour « ${day} » invalide`);
    if (!Array.isArray(ranges)) throw new Error(`allowed_hours : liste de plages attendue pour le jour ${day}`);
    result[weekday as IsoWeekday] = ranges.map((range: unknown) => {
      const { start, end } = (range ?? {}) as { start?: unknown; end?: unknown };
      if (typeof start !== 'string' || typeof end !== 'string') throw new Error(`allowed_hours : plage invalide le jour ${day}`);
      if (minutesOfDay(start) > minutesOfDay(end)) throw new Error(`allowed_hours : ${start} après ${end} le jour ${day}`);
      return { start, end };
    });
  }
  return result;
}

export function calendarOf(row: WorkspaceSettingsRow): WorkspaceCalendar {
  if (!HOLIDAY_CALENDARS.includes(row.holidays_calendar as HolidayCalendarId)) {
    throw new Error(`Calendrier de jours fériés inconnu : ${row.holidays_calendar}`);
  }
  if (!Intl.supportedValuesOf('timeZone').includes(row.timezone) && row.timezone !== 'UTC') {
    throw new Error(`Fuseau horaire inconnu : ${row.timezone}`);
  }
  return {
    timeZone: row.timezone,
    allowedHours: parseAllowedHours(row.allowed_hours),
    holidays: row.holidays_calendar as HolidayCalendarId,
    slotStepMinutes: row.slot_step_minutes,
  };
}

export function slotRulesOf(row: WorkspaceSettingsRow): SlotRules {
  return {
    maxPostsPerAccountPerDay: row.max_posts_per_account_per_day,
    minGapMinutesInWorkspace: row.min_gap_minutes,
    maxWorkspacePostsPerSlot: row.max_posts_per_slot,
  };
}

/** Lundi de la semaine ISO d'un instant, dans le fuseau de l'espace (colonne posts.week_start). */
export function weekStartOf(instant: Date, calendar: WorkspaceCalendar): string {
  return localDate(isoWeekBounds(instant, calendar).start, calendar);
}

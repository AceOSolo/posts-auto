/**
 * Programmation de la rédaction hebdomadaire (GEN-01) : expression cron à 5 champs
 * (minute, heure, jour du mois, mois, jour de la semaine), évaluée à l'heure locale de
 * l'espace. Par défaut « 30 7 * * 1 » : le lundi à 7h30.
 *
 * Forme prise en charge : *, nombres, listes (1,3), intervalles (1-5), pas (*\/15).
 * Jour de la semaine : 0 ou 7 = dimanche, 1 = lundi.
 */
import { DateTime } from 'luxon';

export interface CronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** Jour du mois ou jour de la semaine restreint (règle cron : l'un OU l'autre). */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

function field(text: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (m === null) return null;
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const start = m[1] === '*' ? min : Number(m[2]);
    const end = m[1] === '*' ? max : m[3] === undefined ? (m[4] === undefined ? start : max) : Number(m[3]);
    if (step < 1 || start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

/** Lit une expression ; `null` si elle est invalide. */
export function parseCron(expression: string): CronSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  const minutes = field(mi, 0, 59);
  const hours = field(h, 0, 23);
  const daysOfMonth = field(dom, 1, 31);
  const months = field(mo, 1, 12);
  const rawDow = field(dow, 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDow) return null;
  const daysOfWeek = new Set([...rawDow].map((d) => (d === 0 ? 7 : d)));
  return { minutes, hours, daysOfMonth, months, daysOfWeek, domRestricted: dom !== '*', dowRestricted: dow !== '*' };
}

function dayMatches(schedule: CronSchedule, day: DateTime): boolean {
  if (!schedule.months.has(day.month)) return false;
  const dom = schedule.daysOfMonth.has(day.day);
  const dow = schedule.daysOfWeek.has(day.weekday);
  if (schedule.domRestricted && schedule.dowRestricted) return dom || dow;
  return dom && dow;
}

/** Dernière échéance au plus tard à `now`, cherchée sur `lookbackDays` jours ; `null` s'il n'y en a pas. */
export function lastCronOccurrence(schedule: CronSchedule, now: Date, timeZone: string, lookbackDays = 8): Date | null {
  const local = DateTime.fromJSDate(now, { zone: timeZone });
  for (let back = 0; back <= lookbackDays; back += 1) {
    const day = local.startOf('day').minus({ days: back });
    if (!dayMatches(schedule, day)) continue;
    const times = [...schedule.hours].flatMap((h) => [...schedule.minutes].map((m) => h * 60 + m)).sort((a, b) => b - a);
    for (const minutes of times) {
      const candidate = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour: Math.floor(minutes / 60), minute: minutes % 60 }, { zone: timeZone });
      // Heure inexistante (passage à l'heure d'été) : ignorée.
      if (!candidate.isValid || candidate.hour !== Math.floor(minutes / 60)) continue;
      if (candidate.toMillis() <= now.getTime()) return candidate.toJSDate();
    }
  }
  return null;
}

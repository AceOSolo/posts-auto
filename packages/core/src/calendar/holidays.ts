/**
 * Jours fériés (RÈG-02 : « jours fériés exclus, calendrier français par défaut »).
 * Les dates sont des dates civiles locales au format AAAA-MM-JJ, sans heure ni fuseau.
 */

export type HolidayCalendarId = 'FR' | 'FR-alsace-moselle' | 'none';

export interface Holiday {
  readonly date: string;
  readonly name: string;
}

/** Date de Pâques (calendrier grégorien), algorithme de Meeus / Jones / Butcher. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/** Ajoute des jours à une date civile, en UTC pour ne dépendre d'aucun fuseau. */
function addDays(year: number, month: number, day: number, days: number): string {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Jours fériés légaux en France métropolitaine (Code du travail, art. L3133-1).
 * Le lundi de Pentecôte est inclus : il reste férié même quand il sert de journée
 * de solidarité. Un espace peut changer de calendrier s'il publie ce jour-là.
 */
function frenchHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  const fromEaster = (days: number) => addDays(year, easter.month, easter.day, days);
  return [
    { date: isoDate(year, 1, 1), name: "Jour de l'an" },
    { date: fromEaster(1), name: 'Lundi de Pâques' },
    { date: isoDate(year, 5, 1), name: 'Fête du Travail' },
    { date: isoDate(year, 5, 8), name: 'Victoire 1945' },
    { date: fromEaster(39), name: 'Ascension' },
    { date: fromEaster(50), name: 'Lundi de Pentecôte' },
    { date: isoDate(year, 7, 14), name: 'Fête nationale' },
    { date: isoDate(year, 8, 15), name: 'Assomption' },
    { date: isoDate(year, 11, 1), name: 'Toussaint' },
    { date: isoDate(year, 11, 11), name: 'Armistice 1918' },
    { date: isoDate(year, 12, 25), name: 'Noël' },
  ];
}

export function holidaysOf(calendar: HolidayCalendarId, year: number): Holiday[] {
  switch (calendar) {
    case 'none':
      return [];
    case 'FR':
      return frenchHolidays(year);
    case 'FR-alsace-moselle': {
      const easter = easterSunday(year);
      return [
        ...frenchHolidays(year),
        { date: addDays(year, easter.month, easter.day, -2), name: 'Vendredi saint' },
        { date: isoDate(year, 12, 26), name: 'Saint-Étienne' },
      ].sort((x, y) => x.date.localeCompare(y.date));
    }
  }
}

const cache = new Map<string, ReadonlySet<string>>();

/** `date` au format AAAA-MM-JJ. */
export function isHoliday(calendar: HolidayCalendarId, date: string): boolean {
  const year = Number(date.slice(0, 4));
  const key = `${calendar}:${year}`;
  let dates = cache.get(key);
  if (dates === undefined) {
    dates = new Set(holidaysOf(calendar, year).map((holiday) => holiday.date));
    cache.set(key, dates);
  }
  return dates.has(date);
}

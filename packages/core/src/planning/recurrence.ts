/**
 * Occurrences d'un rendez-vous récurrent (EDI-08), en dates civiles (sans fuseau).
 * Mensuel le 31 : le dernier jour des mois plus courts. Annuel le 29 février : le 28 les
 * années non bissextiles.
 */
import { DateTime } from 'luxon';

export type Recurrence = 'none' | 'weekly' | 'monthly' | 'yearly';
export const RECURRENCES: readonly Recurrence[] = ['none', 'weekly', 'monthly', 'yearly'];

/**
 * Dates des occurrences comprises dans [from, to] (AAAA-MM-JJ), la première étant `startsOn`,
 * sans dépasser `until`. Au plus `limit` dates.
 */
export function occurrences(startsOn: string, recurrence: Recurrence, until: string | null, from: string, to: string, limit = 60): string[] {
  const first = DateTime.fromISO(startsOn, { zone: 'UTC' });
  if (!first.isValid) return [];
  const result: string[] = [];
  for (let n = 0; result.length < limit; n += 1) {
    const date =
      recurrence === 'weekly'
        ? first.plus({ weeks: n })
        : recurrence === 'monthly'
          ? first.plus({ months: n })
          : recurrence === 'yearly'
            ? first.plus({ years: n })
            : n === 0
              ? first
              : null;
    if (date === null) break;
    const iso = date.toISODate() as string;
    if (iso > to || (until !== null && iso > until)) break;
    if (iso >= from) result.push(iso);
  }
  return result;
}

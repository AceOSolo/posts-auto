/**
 * Lecture d'un fichier CSV exporté d'un tableur (Google Sheets, Excel), pour l'import du
 * planning (PLA-05). Gère les guillemets (RFC 4180), les retours à la ligne dans une
 * cellule, l'indicateur d'ordre des octets et le séparateur « ; » d'Excel en français.
 */
import { DateTime } from 'luxon';

/** Séparateur le plus fréquent hors guillemets dans les premières lignes (la première est souvent un titre). */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const head = text.slice(0, 4000);
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<',' | ';' | '\t', number>;
  let quoted = false;
  for (const ch of head) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch as ',' | ';' | '\t'] += 1;
  }
  if (counts['\t'] > counts[';'] && counts['\t'] > counts[',']) return '\t';
  return counts[';'] > counts[','] ? ';' : ',';
}

/** Tableau de lignes ; chaque ligne a le même nombre de colonnes (complétée par des chaînes vides). */
export function parseCsv(input: string, delimiter = detectDelimiter(input)): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  const width = Math.max(0, ...nonEmpty.map((r) => r.length));
  return nonEmpty.map((r) => [...r, ...Array<string>(width - r.length).fill('')]);
}

/** Lundi (AAAA-MM-JJ) de la semaine ISO `week` de l'année ISO `year`. */
export function mondayOfIsoWeek(year: number, week: number): string | null {
  const monday = DateTime.fromObject({ weekYear: year, weekNumber: week, weekday: 1 }, { zone: 'UTC' });
  return monday.isValid && monday.weekNumber === week ? monday.toISODate() : null;
}

/** Numéro de semaine ISO d'une date (AAAA-MM-JJ). */
export function isoWeekNumber(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekNumber;
}

function mondayOf(date: DateTime): string | null {
  return date.isValid ? date.startOf('week').toISODate() : null;
}

/**
 * Semaine désignée par un en-tête de colonne du planning : « S12 », « Semaine 12 »,
 * « 2026-03-16 », « 16/03/2026 », « 16/03 » ou « 16 mars ». Rend le lundi de la semaine,
 * ou `null` si l'en-tête n'est pas une semaine (colonne de libellés, notes…).
 * `year` sert quand l'en-tête ne donne pas l'année.
 */
export function weekFromHeader(header: string, year: number): string | null {
  const h = header.trim().toLowerCase();
  let m = /^(?:s|sem\.?|semaine|w|week)\s*(\d{1,2})$/.exec(h);
  if (m) return mondayOfIsoWeek(year, Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(h);
  if (m) return mondayOf(DateTime.fromObject({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, { zone: 'UTC' }));
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(h);
  if (m) {
    const y = m[3] === undefined ? year : m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mondayOf(DateTime.fromObject({ year: y, month: Number(m[2]), day: Number(m[1]) }, { zone: 'UTC' }));
  }
  m = /^(\d{1,2})\s+([a-zéû]+)\.?(?:\s+(\d{4}))?$/.exec(h);
  if (m) {
    const word = m[2] ?? '';
    const month = MONTH_PREFIXES.find(([prefix]) => word.startsWith(prefix))?.[1];
    if (month === undefined) return null;
    return mondayOf(DateTime.fromObject({ year: m[3] === undefined ? year : Number(m[3]), month, day: Number(m[1]) }, { zone: 'UTC' }));
  }
  return null;
}

const MONTH_PREFIXES: readonly (readonly [string, number])[] = [
  ['janv', 1],
  ['fév', 2],
  ['fev', 2],
  ['mars', 3],
  ['avr', 4],
  ['mai', 5],
  ['juin', 6],
  ['juil', 7],
  ['aoû', 8],
  ['aou', 8],
  ['sep', 9],
  ['oct', 10],
  ['nov', 11],
  ['déc', 12],
  ['dec', 12],
];

/** Sujets d'une cellule : une ligne par sujet (« plusieurs sujets possibles », PLA-02). */
export function subjectsOfCell(cell: string): string[] {
  return cell
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-•*]\s*/, '').trim())
    .filter((line) => line !== '');
}

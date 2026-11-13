/**
 * Import d'un planning de type « PAM » (PLA-05) : une ligne par compte ou par canal, une
 * colonne par semaine ; et d'une banque de sujets (onglets « Edito LK »).
 *
 * Fonctions pures : elles lisent le tableau et proposent un aperçu ; la personne choisit
 * le compte de chaque ligne avant l'import.
 */
import { subjectsOfCell, weekFromHeader } from './csv.ts';

export interface WeekColumn {
  readonly index: number;
  readonly header: string;
  readonly weekStart: string;
}

export interface PamRow {
  /** Libellé de la ligne (première colonne qui n'est pas une semaine). */
  readonly label: string;
  /** Contenu des colonnes de semaine, dans l'ordre de `weekColumns`. */
  readonly cells: readonly string[];
}

export interface PamLayout {
  readonly weekColumns: readonly WeekColumn[];
  readonly rows: readonly PamRow[];
}

/**
 * Repère la ligne d'en-tête (la première où au moins 2 cellules sont des semaines) et la
 * colonne des libellés. Les lignes sans libellé ou sans aucun sujet sont ignorées.
 */
export function readPamLayout(table: readonly (readonly string[])[], year: number): PamLayout | null {
  const headerIndex = table.findIndex((row) => row.filter((cell) => weekFromHeader(cell, year) !== null).length >= 2);
  if (headerIndex === -1) return null;
  const header = table[headerIndex] as readonly string[];
  const weekColumns: WeekColumn[] = [];
  header.forEach((cell, index) => {
    const weekStart = weekFromHeader(cell, year);
    if (weekStart !== null && !weekColumns.some((w) => w.weekStart === weekStart)) weekColumns.push({ index, header: cell.trim(), weekStart });
  });
  const weekIndexes = new Set(weekColumns.map((w) => w.index));
  const labelIndex = header.findIndex((_, index) => !weekIndexes.has(index));
  if (labelIndex === -1) return null;
  const rows: PamRow[] = [];
  for (const row of table.slice(headerIndex + 1)) {
    const label = (row[labelIndex] ?? '').trim();
    const cells = weekColumns.map((w) => row[w.index] ?? '');
    if (label === '' || cells.every((cell) => cell.trim() === '')) continue;
    rows.push({ label, cells });
  }
  return { weekColumns, rows };
}

export type RowTarget =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'event' | 'channel'; readonly label: string }
  | { readonly kind: 'ignore' };

export interface PlannedEntry {
  readonly rowKind: 'account' | 'event' | 'channel';
  readonly accountId: string | null;
  readonly rowLabel: string | null;
  readonly weekStart: string;
  readonly content: string;
  /** Origine dans le fichier : « libellé de ligne | en-tête de colonne ». */
  readonly sourceRef: string;
}

/** Sujets à créer d'après le choix fait pour chaque ligne (une ligne par sujet, PLA-02). */
export function pamEntries(layout: PamLayout, targets: ReadonlyMap<string, RowTarget>): PlannedEntry[] {
  const entries: PlannedEntry[] = [];
  for (const row of layout.rows) {
    const target = targets.get(row.label) ?? { kind: 'ignore' };
    if (target.kind === 'ignore') continue;
    row.cells.forEach((cell, i) => {
      const week = layout.weekColumns[i] as WeekColumn;
      for (const content of subjectsOfCell(cell)) {
        entries.push({
          rowKind: target.kind,
          accountId: target.kind === 'account' ? target.accountId : null,
          rowLabel: target.kind === 'account' ? null : target.label,
          weekStart: week.weekStart,
          content: content.slice(0, 500),
          sourceRef: `${row.label} | ${week.header}`.slice(0, 300),
        });
      }
    });
  }
  return entries;
}

/** Ligne d'une banque de sujets importée. */
export interface SubjectRow {
  readonly subject: string;
  readonly theme: string | null;
  readonly angle: string | null;
  readonly format: string | null;
  readonly offer: string | null;
  readonly audience: string | null;
  readonly published: boolean;
  readonly sourceRef: string;
}

const COLUMN_NAMES: Record<keyof Omit<SubjectRow, 'sourceRef'>, readonly string[]> = {
  subject: ['sujet', 'sujets', 'subject', 'titre', 'idée', 'idee'],
  theme: ['thème', 'theme', 'thématique', 'thematique'],
  angle: ['angle'],
  format: ['format'],
  offer: ['offre', 'produit', 'service'],
  audience: ['cible', 'cibles', 'public', 'audience'],
  published: ['publié', 'publie', 'statut', 'fait', 'posté', 'poste'],
};

const normalize = (value: string) => value.trim().toLowerCase();
const YES = new Set(['oui', 'x', 'yes', 'true', '1', 'publié', 'publie', 'fait', '✓', '✔', 'ok']);

/** Lit une banque de sujets : en-tête reconnu par le nom des colonnes ; la colonne « sujet » est obligatoire. */
export function readSubjectSheet(table: readonly (readonly string[])[]): SubjectRow[] | null {
  const headerIndex = table.findIndex((row) => row.some((cell) => COLUMN_NAMES.subject.includes(normalize(cell))));
  if (headerIndex === -1) return null;
  const header = (table[headerIndex] as readonly string[]).map(normalize);
  const column = (key: keyof typeof COLUMN_NAMES) => header.findIndex((cell) => COLUMN_NAMES[key].includes(cell));
  const indexes = Object.fromEntries((Object.keys(COLUMN_NAMES) as (keyof typeof COLUMN_NAMES)[]).map((key) => [key, column(key)])) as Record<
    keyof typeof COLUMN_NAMES,
    number
  >;
  const read = (row: readonly string[], key: keyof typeof COLUMN_NAMES) => {
    const value = indexes[key] === -1 ? '' : (row[indexes[key]] ?? '').trim();
    return value === '' ? null : value;
  };
  const rows: SubjectRow[] = [];
  table.slice(headerIndex + 1).forEach((row, i) => {
    const subject = read(row, 'subject');
    if (subject === null) return;
    rows.push({
      subject: subject.slice(0, 500),
      theme: read(row, 'theme'),
      angle: read(row, 'angle'),
      format: read(row, 'format'),
      offer: read(row, 'offer'),
      audience: read(row, 'audience'),
      published: YES.has(normalize(read(row, 'published') ?? '')),
      sourceRef: `ligne ${headerIndex + i + 2}`,
    });
  });
  return rows;
}

/**
 * Marqueurs bloquants (GEN-04, VAL-03) : « [À COMPLÉTER : …] » et « [À VÉRIFIER] ».
 * Tant qu'il en reste un, le post ne peut pas être validé.
 *
 * Même détection que la colonne calculée `post_versions.has_blocking_markers`
 * (migration 004) ; un test de @posts-auto/db vérifie que les deux concordent.
 * Les variantes accentuées sont écrites en clair : la casse des lettres accentuées
 * n'est pas fiable partout (locale du serveur PostgreSQL, notamment).
 */

const MARKER_START = String.raw`\[\s*[ÀàAa]\s+(?:compl[ÉéEe]ter|v[ÉéEe]rifier)`;

const DETECT = new RegExp(MARKER_START, 'i');
/** Le marqueur entier, jusqu'au crochet fermant s'il existe (pour le surligner). */
const FIND_ALL = new RegExp(String.raw`${MARKER_START}[^\]\n]*\]?`, 'gi');

export function hasBlockingMarkers(text: string): boolean {
  return DETECT.test(text);
}

export interface MarkerSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Positions des marqueurs, pour les surligner dans l'éditeur (VAL-03). */
export function findBlockingMarkers(text: string): MarkerSpan[] {
  return [...text.matchAll(FIND_ALL)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }));
}

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

/** « [À COMPLÉTER : date] » : l'information demandée se lit après les deux-points. */
const TO_COMPLETE = /^\[\s*[ÀàAa]\s+compl[ÉéEe]ter\s*:\s*([^\]]*?)\s*\]?$/i;

export interface MarkerQuestion extends MarkerSpan {
  /** L'information à fournir, par exemple « date ». */
  readonly label: string;
}

/**
 * Les informations à demander pour compléter le texte sans l'ouvrir. Vide si un seul marqueur
 * ne se résume pas à une question (« [À VÉRIFIER] ») : il faut alors relire le passage.
 */
export function markerQuestions(text: string): MarkerQuestion[] {
  const questions: MarkerQuestion[] = [];
  for (const marker of findBlockingMarkers(text)) {
    const label = TO_COMPLETE.exec(marker.text)?.[1];
    if (label === undefined || label === '') return [];
    questions.push({ ...marker, label });
  }
  return questions;
}

/** Remplace chaque marqueur par la réponse de même rang ; sans réponse, le marqueur reste. */
export function fillMarkers(text: string, answers: readonly string[]): string {
  return findBlockingMarkers(text).reduceRight((filled, marker, index) => {
    const answer = answers[index]?.trim() ?? '';
    return answer === '' ? filled : filled.slice(0, marker.start) + answer + filled.slice(marker.end);
  }, text);
}

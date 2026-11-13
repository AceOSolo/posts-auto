/**
 * Brouillon d'import (PLA-05) : le fichier envoyé est gardé entre l'aperçu et l'import,
 * sous une clé qui contient l'espace et un identifiant aléatoire (impossible à deviner).
 * La page d'aperçu vérifie en plus que la personne peut modifier le planning de l'espace.
 */
export const IMPORT_MAX_BYTES = 1_000_000;

export function draftKey(workspaceId: string, draftId: string): string {
  return `imports/${workspaceId}/${draftId}.csv`;
}

/**
 * Données de test partagées entre paquets (import : `@posts-auto/core/testing`).
 * Rien ici n'est utilisé par le code de production.
 */

/**
 * Textes et résultat attendu pour la détection des marqueurs bloquants (VAL-03).
 * Servent à vérifier que hasBlockingMarkers() et la colonne calculée
 * post_versions.has_blocking_markers donnent le même résultat.
 */
export const BLOCKING_MARKER_SAMPLES: ReadonlyArray<readonly [text: string, blocking: boolean]> = [
  ['Notre webinaire du [À COMPLÉTER : date] sur le DUERP.', true],
  ['Selon l’INRS, [À VÉRIFIER] 30 % des accidents…', true],
  ['[à compléter]', true],
  ['[A COMPLETER : nom du client]', true],
  ['[a verifier]', true],
  ['[ À  COMPLÉTER ]', true],
  ['[À Vérifier : chiffre 2025]', true],
  ['Texte prêt à publier, sans marqueur.', false],
  ['À compléter plus tard (sans crochet)', false],
  ['[Àcompléter] (sans espace)', false],
  ['[Voir le lien]', false],
  ['', false],
];

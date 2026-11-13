/**
 * Contenus externes traités comme des données (GEN-13, REC-17).
 *
 * Tout contenu externe (article, flux RSS, demande libre, idée, post collé) est placé
 * dans un bloc <document>, dont les balises sont neutralisées pour qu'il ne puisse pas en
 * sortir. Les tournures d'injection sont repérées et inscrites au rapport ; elles ne sont
 * jamais appliquées, et les contrôles déterministes de la rédaction s'appliquent de toute
 * façon (une injection réussie ne peut pas faire publier un hashtag).
 */

/** Neutralise les balises <document> et </document> d'un contenu, pour qu'il ne puisse pas fermer son bloc. */
export function neutralizeTags(text: string): string {
  return text.replace(/<(\/?)(document|contexte|consignes|system)/gi, '‹$1$2');
}

/** Bloc de données, avec sa nature et ses attributs (identifiant, source…). */
export function asDocument(type: string, attributes: Readonly<Record<string, string | null | undefined>>, content: string): string {
  const attrs = Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ` ${key}="${String(value).replace(/["<>\n]/g, ' ')}"`)
    .join('');
  return `<document type="${type}"${attrs}>\n${neutralizeTags(content.trim())}\n</document>`;
}

/**
 * Tournures typiques d'une consigne glissée dans un contenu (français et anglais).
 * La liste est volontairement large : un faux positif ne coûte qu'une ligne au rapport.
 */
const PATTERNS: readonly RegExp[] = [
  /\b(ignore[rz]?|oublie[rz]?|ne tiens? pas compte|ne tenez pas compte)\b[^.\n]{0,40}\b(r[èe]gles?|consignes?|instructions?|ce qui pr[ée]c[èe]de)/i,
  // « Nouvelles règles » ou « consignes de sécurité » sont courants dans les articles du
  // domaine (prévention, sécurité) : seules les tournures adressées à l'IA comptent.
  /\bnouvelles? instructions\b/i,
  /\btes (nouvelles )?(consignes|instructions|r[èe]gles)\b/i,
  /\b(tu es|vous [êe]tes) (d[ée]sormais|maintenant|à partir de maintenant)\b/i,
  /\b(en tant qu['’]|agis comme|fais comme si tu [ée]tais) (une? )?(ia|intelligence artificielle|assistant|mod[èe]le)/i,
  /\b(ajoute|ajoutez|mets|mettez|utilise|utilisez)\b[^.\n]{0,30}\b(hashtags?|#)/i,
  /\b(r[ée]v[èe]le|affiche|r[ée]p[èe]te)\b[^.\n]{0,30}\b(consignes|prompt|instructions)/i,
  /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|above|prior|all|your)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)/i,
  /\b(system prompt|you are now|new instructions|act as)\b/i,
];

/** Extraits suspects d'un contenu (au plus 200 caractères chacun). */
export function detectInjection(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (PATTERNS.some((pattern) => pattern.test(line))) found.push(line.trim().slice(0, 200));
  }
  return [...new Set(found)];
}

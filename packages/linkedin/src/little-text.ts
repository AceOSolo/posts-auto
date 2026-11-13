/**
 * Format « little » du champ `commentary` de l'API Posts.
 *
 * Les caractères réservés doivent être précédés d'une barre oblique inverse, même
 * hors de toute mention ou de tout hashtag, sinon le texte peut être mal interprété
 * ou tronqué (ex. une parenthèse, un astérisque de liste à puces).
 * Source : https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 *
 * Par défaut, les hashtags sont publiés comme du texte (RÈG-15 : pas de hashtag).
 * Un espace qui les autorise les publie en hashtags LinkedIn cliquables.
 */

const RESERVED = /[|{}@[\]()<>#\\*_~]/g;

export function escapeLittleText(text: string): string {
  return text.replace(RESERVED, (character) => `\\${character}`);
}

export interface LittleTextOptions {
  /** Transformer « #mot » en hashtag LinkedIn cliquable (désactivé par défaut). */
  readonly linkHashtags?: boolean;
}

/** Un hashtag : « # » en début de texte ou après un blanc, suivi de lettres, chiffres ou « _ ». */
const HASHTAG = /(^|\s)#([\p{L}\p{N}_]+)/gu;

export function toLittleText(text: string, options: LittleTextOptions = {}): string {
  if (!options.linkHashtags) return escapeLittleText(text);

  let result = '';
  let last = 0;
  for (const match of text.matchAll(HASHTAG)) {
    const [whole, before = '', tag = ''] = match;
    const start = match.index;
    result += escapeLittleText(text.slice(last, start) + before);
    result += `{hashtag|\\#|${escapeLittleText(tag)}}`;
    last = start + whole.length;
  }
  return result + escapeLittleText(text.slice(last));
}

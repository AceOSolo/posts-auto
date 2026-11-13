/**
 * Règles de rédaction mesurables (EDI-02, RÈG-15, RÈG-16, RÈG-17).
 *
 * Elles s'appliquent à tout texte rédigé par l'IA, après la vérification par un second
 * passage (GEN-05) : même si une consigne cachée dans un contenu externe trompait le
 * modèle, un hashtag ou une mention ne passerait pas ces contrôles (GEN-13).
 * Elles sont aussi montrées, à titre indicatif, à la personne qui corrige un texte.
 */

export type EmojiPolicy = 'none' | 'rare' | 'free';

export interface EditorialRules {
  /** Nombre maximal de hashtags (0 par défaut, RÈG-15). */
  readonly maxHashtags: number;
  /** Emojis : aucun, rares (2 au plus) ou libres. */
  readonly emojis: EmojiPolicy;
  /** Longueur visée, en caractères. */
  readonly minLength: number;
  readonly maxLength: number;
  /** Liens en fin de texte (RÈG-15). */
  readonly linksAtEnd: boolean;
  /** Mentions @ autorisées : non tant que PUB-08 n'est pas livré (RÈG-15). */
  readonly allowMentions: boolean;
  /** L'accroche doit tenir dans les 2 premières lignes (avant « … voir plus »). */
  readonly hookWithinLines: number;
  /** Une question posée au lecteur. */
  readonly askQuestion: boolean;
}

export const DEFAULT_EDITORIAL_RULES: EditorialRules = {
  maxHashtags: 0,
  emojis: 'rare',
  minLength: 600,
  maxLength: 1300,
  linksAtEnd: true,
  allowMentions: false,
  hookWithinLines: 2,
  askQuestion: true,
};

/** Emojis tolérés avec la règle « rares ». */
export const RARE_EMOJIS_MAX = 2;
/** Au-delà, LinkedIn coupe l'aperçu (« … voir plus ») : environ 210 caractères. */
export const HOOK_MAX_CHARACTERS = 210;
/** Limite de LinkedIn pour le texte d'un post. */
export const LINKEDIN_MAX_CHARACTERS = 3000;

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** Lit les règles enregistrées (JSON) ; toute valeur absente ou invalide prend la valeur par défaut. */
export function parseEditorialRules(raw: unknown): EditorialRules {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_EDITORIAL_RULES;
  const minLength = integer(r['minLength'], d.minLength, 0, LINKEDIN_MAX_CHARACTERS);
  const maxLength = integer(r['maxLength'], d.maxLength, 1, LINKEDIN_MAX_CHARACTERS);
  return {
    maxHashtags: integer(r['maxHashtags'], d.maxHashtags, 0, 30),
    emojis: r['emojis'] === 'none' || r['emojis'] === 'rare' || r['emojis'] === 'free' ? r['emojis'] : d.emojis,
    minLength: Math.min(minLength, maxLength),
    maxLength: Math.max(minLength, maxLength),
    linksAtEnd: typeof r['linksAtEnd'] === 'boolean' ? r['linksAtEnd'] : d.linksAtEnd,
    allowMentions: typeof r['allowMentions'] === 'boolean' ? r['allowMentions'] : d.allowMentions,
    hookWithinLines: integer(r['hookWithinLines'], d.hookWithinLines, 1, 10),
    askQuestion: typeof r['askQuestion'] === 'boolean' ? r['askQuestion'] : d.askQuestion,
  };
}

export type RuleIssueCode =
  | 'hashtag'
  | 'mention'
  | 'link_not_at_end'
  | 'too_long'
  | 'too_short'
  | 'linkedin_limit'
  | 'emoji'
  | 'banned_phrase'
  | 'no_question'
  | 'hook_too_long';

export interface RuleIssue {
  readonly code: RuleIssueCode;
  /** « error » : le texte de l'IA doit être corrigé ; « warning » : signalé seulement. */
  readonly severity: 'error' | 'warning';
  /** Phrase en français, montrée telle quelle (rapport, écran de correction). */
  readonly message: string;
  readonly excerpt?: string;
}

const HASHTAG = /(?:^|[^\p{L}\p{N}&/])(#[\p{L}\p{N}_]+)/gu;
// Une mention commence un mot : « contact@exemple.fr » n'en est pas une.
const MENTION = /(?:^|[\s(«"'])(@[\p{L}\p{N}_][\p{L}\p{N}_.-]*)/gu;
const URL = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/giu;
const EMOJI = /\p{Extended_Pictographic}/gu;

/** Longueur comptée comme LinkedIn : en caractères, pas en unités UTF-16. */
export function characterCount(text: string): number {
  return [...text].length;
}

/** Forme comparable d'un texte : minuscules, sans accents, espaces et ponctuation réduits. */
export function normalizeForComparison(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function matches(regex: RegExp, text: string, group = 1): string[] {
  return [...text.matchAll(regex)].map((m) => m[group] ?? m[0]);
}

export function findLinks(text: string): string[] {
  return matches(URL, text, 0);
}

/** Les liens sont-ils tous à la fin ? Après la première ligne qui contient un lien, toute ligne non vide doit en contenir un. */
function linksAreAtEnd(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => findLinks(line).length > 0);
  if (first === -1) return true;
  return lines.slice(first).every((line) => line.trim() === '' || findLinks(line).length > 0);
}

/** Le texte pose-t-il une question au lecteur (hors lignes de liens) ? */
function asksQuestion(text: string): boolean {
  return text
    .split(/\r?\n/)
    .filter((line) => findLinks(line).length === 0)
    .some((line) => line.includes('?'));
}

export interface CheckOptions {
  /** Mots et formules interdits de la ligne éditoriale (EDI-01). */
  readonly bannedPhrases?: readonly string[];
}

export function checkPostText(text: string, rules: EditorialRules, options: CheckOptions = {}): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const length = characterCount(text);

  const hashtags = matches(HASHTAG, text);
  if (hashtags.length > rules.maxHashtags) {
    issues.push({
      code: 'hashtag',
      severity: 'error',
      message:
        rules.maxHashtags === 0
          ? `Le texte contient ${hashtags.length > 1 ? 'des hashtags' : 'un hashtag'}, ce que la ligne éditoriale exclut.`
          : `Le texte contient ${hashtags.length} hashtags ; ${rules.maxHashtags} au plus.`,
      excerpt: hashtags.join(' '),
    });
  }

  const mentions = matches(MENTION, text);
  if (!rules.allowMentions && mentions.length > 0) {
    issues.push({ code: 'mention', severity: 'error', message: 'Le texte contient une mention @, ce qui n’est pas encore possible.', excerpt: mentions.join(' ') });
  }

  if (rules.linksAtEnd && !linksAreAtEnd(text)) {
    issues.push({ code: 'link_not_at_end', severity: 'error', message: 'Les liens doivent être en fin de texte.' });
  }

  if (length > LINKEDIN_MAX_CHARACTERS) {
    issues.push({ code: 'linkedin_limit', severity: 'error', message: `Le texte dépasse la limite de LinkedIn (${length} caractères sur ${LINKEDIN_MAX_CHARACTERS}).` });
  } else if (length > rules.maxLength) {
    issues.push({ code: 'too_long', severity: 'error', message: `Le texte est trop long : ${length} caractères pour ${rules.maxLength} au plus.` });
  }
  if (length < rules.minLength) {
    issues.push({ code: 'too_short', severity: 'error', message: `Le texte est trop court : ${length} caractères pour ${rules.minLength} au moins.` });
  }

  const emojis = matches(EMOJI, text, 0);
  const emojiMax = rules.emojis === 'none' ? 0 : rules.emojis === 'rare' ? RARE_EMOJIS_MAX : Number.POSITIVE_INFINITY;
  if (emojis.length > emojiMax) {
    issues.push({
      code: 'emoji',
      severity: 'error',
      message: emojiMax === 0 ? 'La ligne éditoriale exclut les emojis.' : `Trop d’emojis : ${emojis.length} pour ${emojiMax} au plus.`,
      excerpt: emojis.join(''),
    });
  }

  const normalized = ` ${normalizeForComparison(text)} `;
  for (const phrase of options.bannedPhrases ?? []) {
    const needle = normalizeForComparison(phrase);
    if (needle !== '' && normalized.includes(` ${needle} `)) {
      issues.push({ code: 'banned_phrase', severity: 'error', message: `Formule interdite par la ligne éditoriale : « ${phrase} ».`, excerpt: phrase });
    }
  }

  if (rules.askQuestion && !asksQuestion(text)) {
    issues.push({ code: 'no_question', severity: 'warning', message: 'Le texte ne pose pas de question au lecteur.' });
  }

  const hook = text.trim().split(/\r?\n/).slice(0, rules.hookWithinLines).join('\n');
  const firstParagraph = text.trim().split(/\r?\n\s*\r?\n/)[0] ?? '';
  if (characterCount(firstParagraph) > HOOK_MAX_CHARACTERS && characterCount(hook) > HOOK_MAX_CHARACTERS) {
    issues.push({
      code: 'hook_too_long',
      severity: 'warning',
      message: `L’accroche dépasse ${HOOK_MAX_CHARACTERS} caractères : LinkedIn la coupera avant « voir plus ».`,
    });
  }
  return issues;
}

/** Une phrase déjà utilisée dans un autre post (RÈG-17). */
export interface RepeatedSentence {
  readonly sentence: string;
  readonly postId: string;
}

/** En dessous, une phrase est trop courte pour qu'une reprise soit significative (« Et vous ? »). */
export const REPEAT_MIN_WORDS = 6;
/** L'accroche (première ligne) est comparée dès 4 mots. */
export const REPEAT_HOOK_MIN_WORDS = 4;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\r?\n+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function words(normalized: string): number {
  return normalized === '' ? 0 : normalized.split(' ').length;
}

/**
 * RÈG-17 : phrases (et accroche) déjà présentes dans d'autres posts de l'espace. Le texte
 * comparé est normalisé : casse, accents et ponctuation ne comptent pas.
 */
export function findRepeatedSentences(
  text: string,
  others: readonly { readonly postId: string; readonly text: string }[],
): RepeatedSentence[] {
  // Phrases d'au moins 6 mots, où qu'elles soient ; accroches comparées entre elles dès 4 mots.
  const sentences = new Map<string, string>();
  const hooks = new Map<string, string>();
  for (const other of others) {
    sentencesOf(other.text).forEach((sentence, i) => {
      const key = normalizeForComparison(sentence);
      if (words(key) >= REPEAT_MIN_WORDS && !sentences.has(key)) sentences.set(key, other.postId);
      if (i === 0 && words(key) >= REPEAT_HOOK_MIN_WORDS && !hooks.has(key)) hooks.set(key, other.postId);
    });
  }
  const found: RepeatedSentence[] = [];
  const seen = new Set<string>();
  sentencesOf(text).forEach((sentence, i) => {
    const key = normalizeForComparison(sentence);
    const postId =
      (words(key) >= REPEAT_MIN_WORDS ? sentences.get(key) : undefined) ??
      (i === 0 && words(key) >= REPEAT_HOOK_MIN_WORDS ? hooks.get(key) : undefined);
    if (postId !== undefined && !seen.has(key)) {
      seen.add(key);
      found.push({ sentence, postId });
    }
  });
  return found;
}

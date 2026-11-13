/**
 * Erreurs de l'API LinkedIn, classées pour décider de la suite (PUB-03, PUB-04).
 *
 * La question décisive n'est pas « l'appel a-t-il échoué ? » mais « le post a-t-il pu
 * être créé quand même ? ». L'API Posts n'offre pas de clé d'unicité : réessayer après
 * une issue incertaine risquerait une double publication. D'où `outcome` :
 * - `not_created` : le post n'existe sûrement pas (échec pendant l'envoi des images,
 *   connexion refusée, refus explicite de LinkedIn) ; réessayer est sans danger ;
 * - `unknown` : la requête de création a pu être traitée (coupure après l'envoi,
 *   erreur 500, 502, 504) ; aucune nouvelle tentative automatique.
 */

export type LinkedInErrorKind =
  /** Jeton absent, expiré ou révoqué (401) : il faut reconnecter le compte. */
  | 'auth'
  /** Permission ou rôle insuffisant sur la page (403). */
  | 'permission'
  /** Requête refusée pour son contenu (400, 404, 422) : réessayer ne changera rien. */
  | 'invalid'
  /** Limite d'appels atteinte (429). */
  | 'rate_limit'
  /** Conflit d'écriture (409) : LinkedIn invite à réessayer. */
  | 'conflict'
  /** Erreur du côté de LinkedIn (5xx). */
  | 'server'
  /** Problème réseau (connexion, délai dépassé). */
  | 'network';

export type LinkedInPhase = 'image_upload' | 'post_create';
export type LinkedInOutcome = 'not_created' | 'unknown';

export class LinkedInError extends Error {
  override readonly name = 'LinkedInError';
  readonly kind: LinkedInErrorKind;
  readonly phase: LinkedInPhase;
  readonly outcome: LinkedInOutcome;
  readonly status: number | null;
  /** Code d'erreur LinkedIn (ex. FIELD_LENGTH_TOO_LONG), si fourni. */
  readonly code: string | null;

  constructor(init: {
    kind: LinkedInErrorKind;
    phase: LinkedInPhase;
    outcome: LinkedInOutcome;
    status?: number | null;
    code?: string | null;
    message: string;
    cause?: unknown;
  }) {
    super(init.message, { cause: init.cause });
    this.kind = init.kind;
    this.phase = init.phase;
    this.outcome = init.outcome;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
  }

  /** Une nouvelle tentative automatique est-elle sans danger et utile ? */
  get retryable(): boolean {
    if (this.outcome !== 'not_created') return false;
    return this.kind === 'rate_limit' || this.kind === 'conflict' || this.kind === 'server' || this.kind === 'network';
  }
}

/** Erreur à partir d'une réponse HTTP de LinkedIn. */
export function errorFromResponse(
  phase: LinkedInPhase,
  status: number,
  body: { message?: unknown; code?: unknown; serviceErrorCode?: unknown } | null,
): LinkedInError {
  const kind: LinkedInErrorKind =
    status === 401 ? 'auth'
    : status === 403 ? 'permission'
    : status === 409 ? 'conflict'
    : status === 429 ? 'rate_limit'
    : status >= 500 ? 'server'
    : 'invalid';
  // 503 : service indisponible, la requête n'a pas été traitée. 500, 502, 504 : issue incertaine.
  const uncertain = phase === 'post_create' && (status === 500 || status === 502 || status === 504);
  const code = typeof body?.code === 'string' ? body.code : null;
  const detail = typeof body?.message === 'string' ? body.message : `HTTP ${status}`;
  return new LinkedInError({
    kind,
    phase,
    outcome: uncertain ? 'unknown' : 'not_created',
    status,
    code,
    message: detail,
  });
}

/**
 * Codes d'erreur réseau qui garantissent que la requête n'est jamais partie
 * (la connexion n'a pas pu s'établir).
 */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function networkCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

/** Erreur à partir d'une exception de fetch (aucune réponse HTTP reçue). */
export function errorFromNetwork(phase: LinkedInPhase, error: unknown): LinkedInError {
  const code = networkCode(error);
  const certainlyNotSent = code !== null && NOT_SENT_CODES.has(code);
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return new LinkedInError({
    kind: 'network',
    phase,
    outcome: phase === 'image_upload' || certainlyNotSent ? 'not_created' : 'unknown',
    code,
    message: timedOut ? 'Délai de réponse de LinkedIn dépassé' : `Erreur réseau${code ? ` (${code})` : ''}`,
    cause: error,
  });
}

/** Message en français pour le titulaire et l'admin (PUB-04 : « message LinkedIn traduit »). */
export function describeForUser(error: LinkedInError): string {
  if (error.outcome === 'unknown') {
    return 'Publication incertaine : LinkedIn n’a pas confirmé la création du post. Vérifiez sur LinkedIn avant de réessayer, pour éviter un doublon.';
  }
  switch (error.kind) {
    case 'auth':
      return 'La connexion LinkedIn de ce compte a expiré ou a été révoquée : reconnectez le compte.';
    case 'permission':
      return 'LinkedIn refuse la publication : la personne connectée n’a plus les droits nécessaires sur ce compte ou cette page.';
    case 'invalid':
      return `LinkedIn a refusé le contenu du post${error.code ? ` (${error.code})` : ''} : vérifiez le texte et les images.`;
    case 'rate_limit':
      return 'LinkedIn limite temporairement le nombre de publications : nouvel essai plus tard.';
    case 'conflict':
    case 'server':
      return 'LinkedIn est momentanément indisponible : nouvel essai plus tard.';
    case 'network':
      return 'LinkedIn est injoignable : nouvel essai plus tard.';
  }
}

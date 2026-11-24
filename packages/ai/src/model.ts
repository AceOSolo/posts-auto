/**
 * Interface d'un modèle de langage, indépendante du fournisseur (décision 0005, ADM-04).
 *
 * Un appel = des consignes système stables (mises en cache), un contexte propre au compte
 * (mis en cache aussi : il sert à tous les posts du compte pendant une génération) et une
 * tâche. La réponse est toujours structurée et validée par un schéma.
 */
import type { z } from 'zod';

/** Objet de l'appel : sert au coût (GEN-11) et au rapport de génération. */
export type Purpose = 'write' | 'verify' | 'rewrite' | 'rework' | 'interpret' | 'learn' | 'visual';

export interface ModelCall<T> {
  readonly purpose: Purpose;
  readonly system: string;
  readonly context: string;
  readonly task: string;
  readonly schema: z.ZodType<T>;
  readonly maxTokens?: number;
  /** Images jointes à la tâche (contrôle d'une image générée, VIS-11). */
  readonly images?: readonly ModelImage[];
}

export interface ModelImage {
  readonly mime: 'image/png' | 'image/jpeg';
  readonly data: Uint8Array;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ModelResult<T> {
  readonly value: T;
  readonly usage: ModelUsage;
  readonly provider: string;
  /** Modèle qui a réellement répondu (il peut différer en cas de repli). */
  readonly model: string;
}

export interface TextModel {
  readonly provider: string;
  readonly model: string;
  call<T>(request: ModelCall<T>): Promise<ModelResult<T>>;
}

export type ModelErrorCode =
  /** Le modèle a décliné la demande (règles de sécurité du fournisseur). */
  | 'refused'
  /** Réponse coupée : limite de longueur atteinte. */
  | 'truncated'
  /** Réponse qui ne respecte pas le schéma. */
  | 'invalid_output'
  /** Fournisseur injoignable, surchargé ou limite de débit : un nouvel essai plus tard peut réussir. */
  | 'unavailable'
  /** Requête refusée (clé invalide, paramètre refusé) : erreur de configuration. */
  | 'rejected';

export class ModelError extends Error {
  override readonly name = 'ModelError';
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  constructor(code: ModelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.retryable = code === 'unavailable' || code === 'truncated' || code === 'invalid_output';
  }
}

export const NO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const UNCONFIGURED_PROVIDER = 'non-configure';

/**
 * Aucun modèle utilisable (clé absente, AI_MODE vide ou inconnu) : chaque appel échoue. Un
 * texte de démonstration ne doit jamais être présenté à un client comme un vrai post.
 */
export class UnconfiguredModel implements TextModel {
  readonly provider = UNCONFIGURED_PROVIDER;
  readonly model = 'non configuré';
  async call<T>(_request: ModelCall<T>): Promise<ModelResult<T>> {
    throw new ModelError('rejected', 'IA non configurée : renseigner AI_MODE=anthropic et ANTHROPIC_API_KEY.');
  }
}

export function isModelConfigured(model: TextModel): boolean {
  return model.provider !== UNCONFIGURED_PROVIDER;
}

/**
 * Modèle réel : API Anthropic par le SDK officiel.
 *
 * - Sorties structurées (`output_config.format`) validées par le schéma zod.
 * - Mise en cache des consignes système et du contexte du compte.
 * - Repli côté serveur (`fallbacks: 'default'`) si le modèle décline une demande.
 * - Nouvel essai automatique par le SDK sur les erreurs passagères (429, 5xx, réseau).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { type ModelCall, ModelError, type ModelResult, type Purpose, type TextModel } from './model.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Effort par objet : la rédaction et la vérification méritent plus de réflexion que l'interprétation d'une demande. */
export const DEFAULT_EFFORT: Readonly<Record<Purpose, Effort>> = {
  write: 'medium',
  rewrite: 'medium',
  rework: 'medium',
  verify: 'medium',
  interpret: 'low',
  learn: 'low',
  visual: 'low',
};

export interface AnthropicModelOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly effort?: Partial<Record<Purpose, Effort>>;
  /** Pour les tests : client fourni. */
  readonly client?: Anthropic;
}

export class AnthropicModel implements TextModel {
  readonly provider = 'anthropic';
  readonly model: string;
  readonly #client: Anthropic;
  readonly #effort: Readonly<Record<Purpose, Effort>>;

  constructor(options: AnthropicModelOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.#client = options.client ?? new Anthropic({ ...(options.apiKey !== undefined && { apiKey: options.apiKey }), maxRetries: 3 });
    this.#effort = { ...DEFAULT_EFFORT, ...options.effort };
  }

  async call<T>(request: ModelCall<T>): Promise<ModelResult<T>> {
    let response;
    try {
      response = await this.#client.beta.messages.parse({
        model: this.model,
        max_tokens: request.maxTokens ?? 16_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: request.context, cache_control: { type: 'ephemeral' } },
              ...(request.images ?? []).map((image) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: image.mime, data: Buffer.from(image.data).toString('base64') },
              })),
              { type: 'text', text: request.task },
            ],
          },
        ],
        output_config: { format: betaZodOutputFormat(request.schema), effort: this.#effort[request.purpose] },
      });
    } catch (error) {
      throw toModelError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new ModelError('refused', `Le modèle a décliné la demande (${response.stop_details?.category ?? 'sans catégorie'}).`);
    }
    if (response.stop_reason === 'max_tokens') throw new ModelError('truncated', 'Réponse coupée : limite de longueur atteinte.');
    const value = response.parsed_output;
    if (value === null || value === undefined) throw new ModelError('invalid_output', 'Réponse illisible : elle ne respecte pas le format attendu.');
    return {
      value: value as T,
      provider: this.provider,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** Erreurs du SDK → erreurs du domaine, de la plus précise à la plus générale. */
export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof Anthropic.RateLimitError) return new ModelError('unavailable', 'Limite de débit du fournisseur atteinte.', { cause: error });
  if (error instanceof Anthropic.InternalServerError) return new ModelError('unavailable', 'Le fournisseur d’IA rencontre une erreur.', { cause: error });
  if (error instanceof Anthropic.APIConnectionError) return new ModelError('unavailable', 'Fournisseur d’IA injoignable.', { cause: error });
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ModelError('rejected', 'Clé du fournisseur d’IA refusée.', { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new ModelError(status >= 500 || status === 408 || status === 409 ? 'unavailable' : 'rejected', `Requête refusée par le fournisseur d’IA (HTTP ${status}).`, { cause: error });
  }
  return new ModelError('unavailable', error instanceof Error ? error.message : 'Erreur inconnue du fournisseur d’IA.', { cause: error });
}

/**
 * Recette (docs/recette-integrations.md) : la clé est valable et le modèle configuré existe.
 * Lecture seule et gratuite : aucun message n'est envoyé au modèle.
 */
export async function verifyAnthropicModel(apiKey: string, model: string, client?: Anthropic): Promise<{ readonly id: string; readonly name: string }> {
  const info = await (client ?? new Anthropic({ apiKey, maxRetries: 1 })).models.retrieve(model);
  return { id: info.id, name: info.display_name };
}

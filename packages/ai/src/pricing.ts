/**
 * Coût d'un appel (GEN-11), en dollars, au tarif public du fournisseur. Le coût réel
 * mesuré pendant le pilote sert à fixer les prix et les quotas (FAC, section 5.13).
 *
 * Tarifs par million de jetons, relevés le 13/11/2026. L'écriture en cache coûte 1,25 fois
 * l'entrée (cache de 5 minutes). Lecture du cache : tarif publié pour Opus 5.5 et Sonnet 5.5 ;
 * estimé à 10 % de l'entrée pour les autres modèles, à vérifier avant de s'en servir.
 */
import type { ModelUsage } from './model.ts';

export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2 },
  'claude-sonnet-5-5': { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.1 },
  'claude-haiku-5-5': { inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01 },
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5 },
  // Modèle simulé : aucun coût.
  simulation: { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 },
};

const CACHE_WRITE_FACTOR = 1.25;

/** Coût en dollars ; un modèle inconnu est compté au tarif du plus cher connu, pour ne jamais sous-estimer. */
export function costUsd(model: string, usage: ModelUsage): number {
  const price = PRICES[model] ?? PRICES['claude-opus-5'] ?? { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5 };
  const cost =
    usage.inputTokens * price.inputPerMillion +
    usage.cacheWriteTokens * price.inputPerMillion * CACHE_WRITE_FACTOR +
    usage.cacheReadTokens * price.cacheReadPerMillion +
    usage.outputTokens * price.outputPerMillion;
  return Math.round(cost) / 1_000_000;
}

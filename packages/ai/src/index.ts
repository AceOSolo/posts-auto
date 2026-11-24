import { AnthropicModel } from './anthropic-model.ts';
import { FakeModel } from './fake-model.ts';
import { type TextModel, UnconfiguredModel } from './model.ts';

export * from './anthropic-model.ts';
export * from './editorial-proposal.ts';
export * from './fake-model.ts';
export * from './image-inspection.ts';
export * from './injection.ts';
export * from './interpreter.ts';
export * from './model.ts';
export * from './pricing.ts';
export * from './prompts.ts';
export * from './repurpose.ts';
export * from './sample-post.ts';
export * from './visual-fill.ts';
export * from './writer.ts';

/**
 * Modèle selon l'environnement : AI_MODE=anthropic avec ANTHROPIC_API_KEY pour le vrai
 * modèle (AI_MODEL pour en changer, ADM-04) ; AI_MODE=fake pour le modèle simulé, qui doit
 * être demandé explicitement. Dans tous les autres cas, aucun modèle n'est disponible.
 */
export function modelFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): TextModel {
  if (env['AI_MODE'] === 'fake') return new FakeModel();
  const key = env['ANTHROPIC_API_KEY']?.trim();
  if (env['AI_MODE'] === 'anthropic' && key) {
    return new AnthropicModel({ apiKey: key, ...(env['AI_MODEL'] && { model: env['AI_MODEL'] }) });
  }
  return new UnconfiguredModel();
}

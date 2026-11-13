import { AnthropicModel } from './anthropic-model.ts';
import { FakeModel } from './fake-model.ts';
import type { TextModel } from './model.ts';

export * from './anthropic-model.ts';
export * from './fake-model.ts';
export * from './image-inspection.ts';
export * from './injection.ts';
export * from './interpreter.ts';
export * from './model.ts';
export * from './pricing.ts';
export * from './prompts.ts';
export * from './visual-fill.ts';
export * from './writer.ts';

/**
 * Modèle selon l'environnement : AI_MODE=anthropic avec ANTHROPIC_API_KEY pour le vrai
 * modèle (AI_MODEL pour en changer, ADM-04) ; sinon le modèle simulé.
 */
export function modelFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): TextModel {
  const key = env['ANTHROPIC_API_KEY'];
  if (env['AI_MODE'] === 'anthropic' && key !== undefined && key !== '') {
    return new AnthropicModel({ apiKey: key, ...(env['AI_MODEL'] && { model: env['AI_MODEL'] }) });
  }
  return new FakeModel();
}

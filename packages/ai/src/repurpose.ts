/**
 * Déclinaison d'un contenu : à partir d'un article (du blog de l'entreprise, d'un média,
 * d'une page du site), l'IA propose plusieurs angles de posts distincts, déposés comme idées
 * dans la boîte à idées. L'article est une donnée (GEN-13) : rien n'y est appliqué, et les
 * angles ne promettent que ce que l'article dit.
 */
import { z } from 'zod';
import { asDocument, detectInjection } from './injection.ts';
import type { TextModel } from './model.ts';
import { REPURPOSE_SYSTEM } from './prompts.ts';
import type { UsageRecord } from './writer.ts';

export const AnglesSchema = z.object({
  angles: z.array(z.object({ title: z.string(), details: z.string() })),
  ignoredInstructions: z.array(z.string()),
});

export interface RepurposeInput {
  readonly companyName: string;
  readonly sector: string | null;
  readonly positioning: string | null;
  readonly article: { readonly url: string; readonly text: string };
  readonly count: number;
}

export interface PostAngle {
  readonly title: string;
  readonly details: string;
}

export const REPURPOSE_TASK_PREFIX = 'Décline l’article en angles de posts';

export function renderRepurposeTask(input: RepurposeInput): string {
  return [
    `${REPURPOSE_TASK_PREFIX} LinkedIn pour ${input.companyName}${input.sector ? ` (secteur : ${input.sector})` : ''} : ${input.count} angles distincts.`,
    input.positioning ? `Positionnement de l’entreprise : ${input.positioning}` : '',
    asDocument('article', { adresse: input.article.url }, input.article.text),
  ]
    .filter(Boolean)
    .join('\n\n');
}

const clip = (text: string, max: number) => text.replace(/[ \t]+/g, ' ').trim().slice(0, max);

export async function proposeAngles(model: TextModel, input: RepurposeInput): Promise<{ angles: PostAngle[]; suspicious: string[]; call: UsageRecord }> {
  const result = await model.call({
    purpose: 'interpret',
    system: REPURPOSE_SYSTEM,
    context: 'Déclinaison d’un article en idées de posts.',
    task: renderRepurposeTask(input),
    schema: AnglesSchema,
    maxTokens: 2000,
  });
  const seen = new Set<string>();
  const angles = result.value.angles
    .map((a) => ({ title: clip(a.title, 200), details: clip(a.details, 1500) }))
    .filter((a) => a.title !== '' && !seen.has(a.title.toLowerCase()) && seen.add(a.title.toLowerCase()))
    .slice(0, input.count);
  return {
    angles,
    suspicious: [...new Set([...detectInjection(input.article.text), ...result.value.ignoredInstructions])],
    call: { purpose: 'interpret', provider: result.provider, model: result.model, usage: result.usage },
  };
}

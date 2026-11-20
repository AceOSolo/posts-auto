/**
 * Post d'exemple du démarrage : dès que l'entreprise a indiqué son site, l'IA rédige un post
 * à partir de ce que dit le site, pour montrer tout de suite le résultat, avant même la
 * connexion d'un compte LinkedIn. Il n'est ni enregistré comme post ni publié. Mêmes règles
 * que la rédaction : rien d'inventé (marqueurs à la place), le site est une donnée (GEN-13).
 */
import { z } from 'zod';
import { asDocument, detectInjection } from './injection.ts';
import type { TextModel } from './model.ts';
import { SAMPLE_POST_SYSTEM } from './prompts.ts';
import type { UsageRecord } from './writer.ts';

export const SamplePostSchema = z.object({
  body: z.string(),
  summary: z.string(),
  ignoredInstructions: z.array(z.string()),
});

export interface SamplePostInput {
  readonly companyName: string;
  readonly sector: string | null;
  /** Ligne éditoriale déjà enregistrée (positionnement, ton), s'il y en a une. */
  readonly editorial: { readonly positioning: string | null; readonly tone: string | null } | null;
  readonly pages: readonly { readonly url: string; readonly text: string }[];
}

export interface SamplePostDraft {
  readonly body: string;
  readonly summary: string;
  readonly suspiciousInstructions: readonly string[];
}

export const SAMPLE_POST_MIN_LENGTH = 600;
export const SAMPLE_POST_MAX_LENGTH = 1300;

export function renderSamplePostContext(input: SamplePostInput): string {
  return [
    `Entreprise : ${input.companyName}${input.sector ? ` (secteur : ${input.sector})` : ''}. Le post paraît sur la page LinkedIn de l'entreprise, à la voix « nous ».`,
    `Règles de rédaction : longueur entre ${SAMPLE_POST_MIN_LENGTH} et ${SAMPLE_POST_MAX_LENGTH} caractères ; au plus 3 hashtags ; émojis rares.`,
    input.editorial?.positioning ? `Positionnement : ${input.editorial.positioning}` : '',
    input.editorial?.tone ? `Ton : ${input.editorial.tone}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderSamplePostTask(input: SamplePostInput): string {
  return [
    `Rédige un post LinkedIn d'exemple pour ${input.companyName}.`,
    'Sujet : un post de présentation tiré du site, sur l’offre ou le savoir-faire le plus concret qu’il décrit.',
    ...input.pages.map((page, i) => asDocument('page_du_site', { id: `page-${i + 1}`, adresse: page.url }, page.text)),
  ].join('\n\n');
}

export async function writeSamplePost(model: TextModel, input: SamplePostInput): Promise<{ draft: SamplePostDraft; call: UsageRecord }> {
  const result = await model.call({
    purpose: 'write',
    system: SAMPLE_POST_SYSTEM,
    context: renderSamplePostContext(input),
    task: renderSamplePostTask(input),
    schema: SamplePostSchema,
    maxTokens: 2000,
  });
  const v = result.value;
  return {
    call: { purpose: 'write', provider: result.provider, model: result.model, usage: result.usage },
    draft: {
      body: v.body.trim().slice(0, 3000),
      summary: v.summary.replace(/\s+/g, ' ').trim().slice(0, 300),
      suspiciousInstructions: [...new Set([...detectInjection(input.pages.map((p) => p.text).join('\n')), ...v.ignoredInstructions])],
    },
  };
}

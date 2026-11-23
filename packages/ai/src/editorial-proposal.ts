/**
 * Ligne éditoriale proposée par l'IA (ONB-04) à partir du site de l'entreprise et de posts
 * collés par la personne ; elle corrige puis valide. Le site et les posts sont des données
 * (GEN-13) : une consigne qu'ils contiendraient est relevée, jamais appliquée.
 */
import { z } from 'zod';
import { asDocument, detectInjection } from './injection.ts';
import type { TextModel } from './model.ts';
import { EDITORIAL_PROPOSAL_SYSTEM } from './prompts.ts';
import type { UsageRecord } from './writer.ts';

export const EditorialProposalSchema = z.object({
  positioning: z.string(),
  offers: z.string(),
  audiences: z.string(),
  allowedProofs: z.string(),
  tone: z.string(),
  bannedPhrases: z.array(z.string()),
  toVerify: z.array(z.string()),
  ignoredInstructions: z.array(z.string()),
});

export interface EditorialProposalInput {
  readonly companyName: string;
  readonly sector: string | null;
  /** Texte des pages du site (adresse et contenu). */
  readonly pages: readonly { readonly url: string; readonly text: string }[];
  /** Posts ajoutés un par un par la personne ; le lien, facultatif, indique leur origine. */
  readonly posts: readonly { readonly text: string; readonly url: string | null }[];
}

export interface EditorialDraft {
  readonly positioning: string;
  readonly offers: string;
  readonly audiences: string;
  readonly allowedProofs: string;
  readonly tone: string;
  readonly bannedPhrases: readonly string[];
  readonly toVerify: readonly string[];
  readonly suspiciousInstructions: readonly string[];
}

export function renderProposalTask(input: EditorialProposalInput): string {
  return [
    `Propose la ligne éditoriale LinkedIn de ${input.companyName}${input.sector ? ` (secteur : ${input.sector})` : ''}.`,
    ...input.pages.map((page, i) => asDocument('page_du_site', { id: `page-${i + 1}`, adresse: page.url }, page.text)),
    ...input.posts.map((post, i) => asDocument('post_publie', { id: `post-${i + 1}`, ...(post.url === null ? {} : { adresse: post.url }) }, post.text)),
  ].join('\n\n');
}

const clip = (text: string, max: number) => text.replace(/[ \t]+/g, ' ').trim().slice(0, max);

export async function proposeEditorialLine(model: TextModel, input: EditorialProposalInput): Promise<{ draft: EditorialDraft; call: UsageRecord }> {
  const result = await model.call({
    purpose: 'interpret',
    system: EDITORIAL_PROPOSAL_SYSTEM,
    context: 'Proposition de ligne éditoriale.',
    task: renderProposalTask(input),
    schema: EditorialProposalSchema,
    maxTokens: 4000,
  });
  const v = result.value;
  const external = [...input.pages.map((p) => p.text), ...input.posts.map((p) => p.text)].join('\n');
  return {
    call: { purpose: 'interpret', provider: result.provider, model: result.model, usage: result.usage },
    draft: {
      positioning: clip(v.positioning, 2000),
      offers: clip(v.offers, 2000),
      audiences: clip(v.audiences, 2000),
      allowedProofs: clip(v.allowedProofs, 2000),
      tone: clip(v.tone, 2000),
      bannedPhrases: v.bannedPhrases.map((p) => clip(p, 200)).filter((p) => p !== '').slice(0, 30),
      toVerify: v.toVerify.map((p) => clip(p, 300)).filter((p) => p !== '').slice(0, 10),
      suspiciousInstructions: [...new Set([...detectInjection(external), ...v.ignoredInstructions])],
    },
  };
}

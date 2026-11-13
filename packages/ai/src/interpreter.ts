/**
 * Interprétation d'une demande libre (IDE-04) : l'IA pré-remplit les champs du formulaire
 * (comptes, sujet, informations, liens, date), que la personne vérifie avant d'envoyer.
 * Le texte de la demande est une donnée (GEN-13).
 */
import { z } from 'zod';
import { asDocument, detectInjection } from './injection.ts';
import type { TextModel } from './model.ts';
import { INTERPRETER_SYSTEM } from './prompts.ts';
import type { UsageRecord } from './writer.ts';

export const InterpretationSchema = z.object({
  accountIds: z.array(z.string()),
  title: z.string(),
  details: z.string(),
  links: z.array(z.string()),
  wishedDate: z.string().describe('AAAA-MM-JJ, ou chaîne vide'),
  wishedTime: z.string().describe('HH:mm, ou chaîne vide'),
  toSpecify: z.array(z.string()),
  ignoredInstructions: z.array(z.string()),
});

export interface InterpretInput {
  readonly rawText: string;
  readonly accounts: readonly { readonly id: string; readonly name: string }[];
  /** Date du jour à l'heure de l'espace, pour résoudre « mardi prochain » : « vendredi 13 novembre 2026 (2026-11-13) ». */
  readonly today: string;
}

export interface Interpretation {
  readonly accountIds: readonly string[];
  readonly title: string;
  readonly details: string;
  readonly links: readonly string[];
  readonly wishedDate: string | null;
  readonly wishedTime: string | null;
  readonly toSpecify: readonly string[];
  readonly suspiciousInstructions: readonly string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function interpretRequest(model: TextModel, input: InterpretInput): Promise<{ interpretation: Interpretation; call: UsageRecord }> {
  const context = [`Date du jour : ${input.today}.`, 'Comptes de l’espace (identifiant : nom) :', ...input.accounts.map((a) => `- ${a.id} : ${a.name}`)].join('\n');
  const result = await model.call({
    purpose: 'interpret',
    system: INTERPRETER_SYSTEM,
    context,
    task: `Remplis le formulaire à partir de cette demande.\n\n${asDocument('demande', { id: 'demande' }, input.rawText)}`,
    schema: InterpretationSchema,
    maxTokens: 4000,
  });
  const v = result.value;
  const known = new Set(input.accounts.map((a) => a.id));
  const date = ISO_DATE.test(v.wishedDate) && !Number.isNaN(new Date(`${v.wishedDate}T00:00:00Z`).getTime()) ? v.wishedDate : null;
  return {
    call: { purpose: 'interpret', provider: result.provider, model: result.model, usage: result.usage },
    interpretation: {
      accountIds: [...new Set(v.accountIds.filter((id) => known.has(id)))],
      title: v.title.trim().slice(0, 300),
      details: v.details.trim().slice(0, 5000),
      links: v.links.filter((l) => /^https?:\/\/\S+$/i.test(l)).slice(0, 10),
      wishedDate: date,
      wishedTime: date !== null && TIME.test(v.wishedTime) ? v.wishedTime : null,
      toSpecify: v.toSpecify.slice(0, 10),
      suspiciousInstructions: [...new Set([...detectInjection(input.rawText), ...v.ignoredInstructions])],
    },
  };
}

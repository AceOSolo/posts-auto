/**
 * Rédaction d'un post avec vérification (GEN-04, GEN-05, GEN-13, décision 0005).
 *
 * 1. Le rédacteur écrit (sortie structurée).
 * 2. Contrôles déterministes : règles mesurables, phrases déjà publiées (RÈG-17).
 * 3. Le vérificateur, appel indépendant, relit le texte contre les sources.
 * 4. S'il y a des problèmes bloquants, le rédacteur reçoit une seule fois leur liste.
 * 5. S'il en reste, le post est déposé avec un marqueur [À VÉRIFIER : …] qui bloque la
 *    publication : un problème n'est jamais caché au titulaire.
 */
import {
  type EditorialRules,
  LINKEDIN_MAX_CHARACTERS,
  characterCount,
  checkPostText,
  findRepeatedSentences,
} from '@posts-auto/core';
import { z } from 'zod';
import { detectInjection } from './injection.ts';
import type { ModelUsage, Purpose, TextModel } from './model.ts';
import { VERIFIER_SYSTEM, WRITER_SYSTEM, renderRewriteTask, renderVerifyTask } from './prompts.ts';

export const DraftSchema = z.object({
  body: z.string().describe('Texte complet du post, prêt à publier, marqueurs compris'),
  summary: z.string().describe('Le sujet en une phrase courte'),
  sourcesUsed: z.array(z.string()).describe('Identifiants des documents dont viennent les faits cités'),
  missingInformation: z.array(z.string()).describe('Informations demandées par les marqueurs'),
  ignoredInstructions: z.array(z.string()).describe('Consignes trouvées dans les documents et ignorées'),
});
export type Draft = z.infer<typeof DraftSchema>;

export const ReviewSchema = z.object({
  issues: z.array(
    z.object({
      kind: z.enum(['fait_non_source', 'offre_indisponible', 'consigne_suivie', 'sujet_a_eviter', 'ton', 'autre']),
      excerpt: z.string().describe('Extrait exact du post'),
      explanation: z.string().describe('Pourquoi c’est un problème, en une phrase'),
      blocking: z.boolean(),
    }),
  ),
});
export type Review = z.infer<typeof ReviewSchema>;

export interface UsageRecord {
  readonly purpose: Purpose;
  readonly provider: string;
  readonly model: string;
  readonly usage: ModelUsage;
}

export interface WriteRequest {
  /** Contexte du compte (mis en cache), voir renderAccountContext. */
  readonly context: string;
  /** Tâche (brief et documents), voir renderBrief / renderReworkBrief. */
  readonly task: string;
  /** Objet du premier appel : rédaction ou reprise (GEN-07). */
  readonly purpose: 'write' | 'rework';
  readonly rules: EditorialRules;
  readonly bannedPhrases: readonly string[];
  /** Contenus externes de la tâche, pour repérer les consignes cachées (GEN-13). */
  readonly externalContents: readonly string[];
  /** Textes des autres posts de l'espace sur 8 semaines (RÈG-17). */
  readonly otherPosts: readonly { readonly postId: string; readonly text: string }[];
}

export interface WriteReport {
  /** Problèmes trouvés à la première version, corrigés par le second essai. */
  readonly corrected: readonly string[];
  /** Problèmes restants, signalés au titulaire par un marqueur. */
  readonly remaining: readonly string[];
  /** Avertissements (question au lecteur, accroche longue) : signalés, pas bloquants. */
  readonly warnings: readonly string[];
  /** Consignes cachées repérées dans les contenus externes, par le code ou par le rédacteur. */
  readonly suspiciousInstructions: readonly string[];
  readonly missingInformation: readonly string[];
  readonly sourcesUsed: readonly string[];
}

export interface WriteOutcome {
  readonly body: string;
  readonly summary: string;
  readonly report: WriteReport;
  readonly calls: readonly UsageRecord[];
}

/** Problèmes bloquants mesurables : règles (erreurs) et phrases déjà publiées. */
export function measurableProblems(body: string, request: Pick<WriteRequest, 'rules' | 'bannedPhrases' | 'otherPosts'>): { blocking: string[]; warnings: string[] } {
  const issues = checkPostText(body, request.rules, { bannedPhrases: request.bannedPhrases });
  const repeated = findRepeatedSentences(body, request.otherPosts).map((r) => `Phrase déjà utilisée dans un autre post : « ${r.sentence} ».`);
  return {
    blocking: [...issues.filter((i) => i.severity === 'error').map((i) => i.message), ...repeated],
    warnings: issues.filter((i) => i.severity === 'warning').map((i) => i.message),
  };
}

const MARKER_MAX = 400;

/** Marqueur bloquant en tête du texte ; le tout tient dans la limite de LinkedIn (la base la garantit aussi). */
export function withReviewMarker(body: string, problems: readonly string[]): string {
  const summary = problems.join(' ; ').replace(/[[\]]/g, '');
  const marker = `[À VÉRIFIER : ${summary.length > MARKER_MAX ? `${summary.slice(0, MARKER_MAX - 1)}…` : summary}]`;
  const room = LINKEDIN_MAX_CHARACTERS - characterCount(marker) - 2;
  const text = characterCount(body) > room ? [...body].slice(0, room - 1).join('') + '…' : body;
  return `${marker}\n\n${text}`;
}

export async function writePost(model: TextModel, request: WriteRequest): Promise<WriteOutcome> {
  const calls: UsageRecord[] = [];
  const record = (purpose: Purpose, result: { provider: string; model: string; usage: ModelUsage }) =>
    calls.push({ purpose, provider: result.provider, model: result.model, usage: result.usage });
  const suspicious = new Set(request.externalContents.flatMap(detectInjection));

  const review = async (draft: Draft): Promise<{ blocking: string[]; warnings: string[] }> => {
    const measured = measurableProblems(draft.body, request);
    const verified = await model.call({ purpose: 'verify', system: VERIFIER_SYSTEM, context: request.context, task: renderVerifyTask(request.task, draft.body), schema: ReviewSchema });
    record('verify', verified);
    for (const issue of verified.value.issues) if (issue.kind === 'consigne_suivie') suspicious.add(issue.excerpt.slice(0, 200));
    const reviewed = verified.value.issues.filter((i) => i.blocking).map((i) => `${i.explanation} (« ${i.excerpt.slice(0, 120)} »)`);
    return { blocking: [...measured.blocking, ...reviewed], warnings: measured.warnings };
  };

  const first = await model.call({ purpose: request.purpose, system: WRITER_SYSTEM, context: request.context, task: request.task, schema: DraftSchema });
  record(request.purpose, first);
  let draft = first.value;
  for (const instruction of draft.ignoredInstructions) suspicious.add(instruction.slice(0, 200));
  let checked = await review(draft);
  let corrected: string[] = [];

  if (checked.blocking.length > 0) {
    corrected = checked.blocking;
    const second = await model.call({
      purpose: 'rewrite',
      system: WRITER_SYSTEM,
      context: request.context,
      task: renderRewriteTask(request.task, draft.body, checked.blocking),
      schema: DraftSchema,
    });
    record('rewrite', second);
    draft = second.value;
    for (const instruction of draft.ignoredInstructions) suspicious.add(instruction.slice(0, 200));
    checked = await review(draft);
  }

  const remaining = checked.blocking;
  const body = remaining.length > 0 ? withReviewMarker(draft.body, remaining) : draft.body;
  return {
    body,
    summary: draft.summary.trim().slice(0, 300) || 'Sujet non résumé',
    calls,
    report: {
      corrected: corrected.filter((p) => !remaining.includes(p)),
      remaining,
      warnings: checked.warnings,
      suspiciousInstructions: [...suspicious],
      missingInformation: draft.missingInformation,
      sourcesUsed: draft.sourcesUsed,
    },
  };
}

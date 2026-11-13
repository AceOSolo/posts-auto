/**
 * Retouches à la demande (GEN-08) : « raccourcir », « changer de ton », « régénérer »,
 * « proposer 3 accroches », au moment de valider.
 *
 * Accessible à qui peut corriger le post (titulaire, délégué, gestion du contenu : matrice
 * 3.3), sur un post « à valider ». Une retouche est une nouvelle révision du même post,
 * vérifiée comme toute rédaction (GEN-05) ; elle ne compte pas dans le quota (RÈG-19).
 * Une révision demandée par une personne protège le post d'un remplacement (GEN-03).
 */
import {
  ASSIST_INSTRUCTIONS,
  type AssistKind,
  PROMPT_VERSION,
  type TextModel,
  type UsageRecord,
  WRITER_SYSTEM,
  costUsd,
  renderAccountContext,
  renderAssistTask,
  renderHooksTask,
  writePost,
} from '@posts-auto/ai';
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { canEditPost, loadAccess } from '../access.ts';
import { audit } from '../audit.ts';
import { accountProfileForSystem, referencePostsOf } from '../editorial/account-profiles.ts';
import { currentEditorialLine, offerItems } from '../editorial/editorial-line.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

export const ASSIST_KINDS = Object.keys(ASSIST_INSTRUCTIONS) as AssistKind[];
/** Les accroches proposées restent affichées une heure. */
export const HOOKS_TTL_MINUTES = 60;

const HooksSchema = z.object({ hooks: z.array(z.string()).describe('Trois accroches') });

interface EditablePost {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  readonly body: string;
  readonly revision: number;
}

async function loadEditable(db: Database, userId: string, postId: string): Promise<EditablePost> {
  return asUser(db, userId, async (trx) => {
    const post = await trx
      .selectFrom('posts as p')
      .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.id', 'p.workspace_id', 'p.account_id', 'p.status', 'v.body', 'v.revision'])
      .where('p.id', '=', postId)
      .executeTakeFirst();
    if (post === undefined) throw new NotFoundError('Post');
    if (!canEditPost(await loadAccess(trx, userId, post.workspace_id, post.account_id))) throw new ForbiddenError('assist');
    if (post.status !== 'a_valider') throw new RefusedError('not_editable', 'Les retouches par l’IA se font sur un post à valider.');
    return post;
  });
}

/** Au plus 30 retouches par personne et par heure : chacune coûte des appels à l'IA. */
export const ASSIST_MAX_PER_HOUR = 30;

/** Compte la retouche demandée (journal d'audit) ; refuse au-delà de la limite horaire. */
async function consumeAssistBudget(db: Database, userId: string, post: EditablePost, kind: string, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    const recent = await trx
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('actor_user_id', '=', userId)
      .where('action', '=', 'post.retouche_ia')
      .where('at', '>', new Date(now.getTime() - 3_600_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= ASSIST_MAX_PER_HOUR) throw new RefusedError('trop_de_retouches', 'Trop de retouches demandées : réessayez dans une heure.');
    await audit(trx, { workspaceId: post.workspace_id, actorUserId: userId, action: 'post.retouche_ia', entity: 'post', entityId: post.id, details: { kind }, at: now });
  });
}

/** Contexte du compte pour l'IA (même contenu que pour la rédaction hebdomadaire). */
async function contextFor(trx: Tx, workspaceId: string, accountId: string): Promise<{ context: string; editorial: Awaited<ReturnType<typeof currentEditorialLine>> }> {
  const workspace = await trx.selectFrom('workspaces').select('name').where('id', '=', workspaceId).executeTakeFirstOrThrow();
  const editorial = await currentEditorialLine(trx, workspaceId);
  const offer = await offerItems(trx, workspaceId);
  const profile = await accountProfileForSystem(trx, accountId);
  if (profile === null) throw new NotFoundError('Compte');
  const learned = await trx.selectFrom('learned_preferences').select('summary').where('account_id', '=', accountId).executeTakeFirst();
  const examples = await referencePostsOf(trx, accountId);
  const context = renderAccountContext({
    workspaceName: workspace.name,
    editorial,
    rules: editorial.rules,
    offer: offer.map((o) => ({ name: o.name, description: o.description, status: o.status, pricing: o.pricing })),
    account: { name: profile.displayName ?? 'Compte', kind: profile.kind, voice: profile.voice, tenor: profile.tenor, sensitivity: profile.sensitivity, avoid: profile.avoid },
    learnedPreferences: learned?.summary ?? '',
    examples: examples.map((e) => ({ label: e.label, body: e.body, note: e.note })),
    recentPosts: [],
  });
  return { context, editorial };
}

async function recordAssistUsage(trx: Tx, post: EditablePost, runId: string, calls: readonly UsageRecord[], usdToEur: number, now: Date): Promise<void> {
  if (calls.length === 0) return;
  await trx
    .insertInto('ai_usage')
    .values(
      calls.map((call) => {
        const usd = costUsd(call.model, call.usage);
        return {
          workspace_id: post.workspace_id,
          account_id: post.account_id,
          run_id: runId,
          post_id: post.id,
          provider: call.provider,
          model: call.model,
          purpose: call.purpose,
          kind: 'text' as const,
          input_tokens: call.usage.inputTokens,
          output_tokens: call.usage.outputTokens,
          cache_read_tokens: call.usage.cacheReadTokens,
          cache_write_tokens: call.usage.cacheWriteTokens,
          cost_usd: usd.toFixed(6),
          cost_eur: (usd * usdToEur).toFixed(6),
          counted_in_quota: false,
          at: now,
        };
      }),
    )
    .execute();
}

/** Retouche du texte : nouvelle révision du post, vérifiée. Rend les problèmes restants (marqueur [À VÉRIFIER] posé). */
export async function assistPost(
  db: Database,
  model: TextModel,
  userId: string,
  postId: string,
  kind: AssistKind,
  now: Date,
  usdToEur = 0.86,
): Promise<{ remaining: readonly string[] }> {
  if (!ASSIST_KINDS.includes(kind)) throw new RefusedError('retouche_inconnue', 'Retouche inconnue.');
  const post = await loadEditable(db, userId, postId);
  await consumeAssistBudget(db, userId, post, kind, now);
  const { context, editorial } = await asSystem(db, (trx) => contextFor(trx, post.workspace_id, post.account_id));
  const others = await asSystem(db, (trx) =>
    trx
      .selectFrom('posts as p')
      .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.id', 'v.body'])
      .where('p.workspace_id', '=', post.workspace_id)
      .where('p.id', '<>', post.id)
      .where('p.status', '<>', 'remplace')
      .where('p.scheduled_at', '>=', new Date(now.getTime() - 56 * 86_400_000))
      .execute(),
  );
  const outcome = await writePost(model, {
    context,
    task: renderAssistTask(post.body, kind),
    purpose: 'rework',
    rules: editorial.rules,
    bannedPhrases: editorial.bannedPhrases,
    externalContents: [],
    otherPosts: others.map((o) => ({ postId: o.id, text: o.body })),
  });
  await asSystem(db, async (trx) => {
    // Le post a pu changer pendant la rédaction : on ne retouche qu'un post encore « à valider », à la même révision.
    const current = await trx
      .selectFrom('posts as p')
      .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.status', 'v.revision'])
      .where('p.id', '=', post.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (current.status !== 'a_valider' || current.revision !== post.revision) throw new RefusedError('post_modifie', 'Le post a changé pendant la retouche : rechargez la page.');
    const run = await trx
      .insertInto('generation_runs')
      .values({ workspace_id: post.workspace_id, kind: 'on_demand', status: 'done', started_at: now, finished_at: now, model: model.model, prompt_version: PROMPT_VERSION, triggered_by: userId, report: JSON.stringify({ postId, kind, remaining: outcome.report.remaining }) })
      .returning('id')
      .executeTakeFirstOrThrow();
    const version = await trx
      .insertInto('post_versions')
      .values({ workspace_id: post.workspace_id, post_id: post.id, revision: post.revision + 1, body: outcome.body, author_kind: 'ai', author_user_id: userId, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.updateTable('posts').set({ current_version_id: version.id }).where('id', '=', post.id).execute();
    await trx
      .insertInto('post_status_history')
      .values({ workspace_id: post.workspace_id, post_id: post.id, from_status: 'a_valider', to_status: 'a_valider', actor_kind: 'user', actor_user_id: userId, reason: `Retouche demandée à l’IA : ${ASSIST_INSTRUCTIONS[kind]}`, at: now })
      .execute();
    await recordAssistUsage(trx, post, run.id, outcome.calls, usdToEur, now);
  });
  return { remaining: outcome.report.remaining };
}

/** Trois accroches proposées ; elles restent disponibles une heure sur la page du post. */
export async function proposeHooks(db: Database, model: TextModel, userId: string, postId: string, now: Date, usdToEur = 0.86): Promise<readonly string[]> {
  const post = await loadEditable(db, userId, postId);
  await consumeAssistBudget(db, userId, post, 'accroches', now);
  const { context } = await asSystem(db, (trx) => contextFor(trx, post.workspace_id, post.account_id));
  const result = await model.call({ purpose: 'rework', system: WRITER_SYSTEM, context, task: renderHooksTask(post.body), schema: HooksSchema, maxTokens: 4000 });
  const hooks = result.value.hooks
    .map((h) => h.replace(/\s*#[\p{L}\p{N}_]+/gu, '').trim())
    .filter((h) => h !== '')
    .slice(0, 3);
  await asSystem(db, async (trx) => {
    const run = await trx
      .insertInto('generation_runs')
      .values({ workspace_id: post.workspace_id, kind: 'on_demand', status: 'done', started_at: now, finished_at: now, model: model.model, prompt_version: PROMPT_VERSION, triggered_by: userId, report: JSON.stringify({ postId, kind: 'accroches', hooks, revision: post.revision }) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordAssistUsage(trx, post, run.id, [{ purpose: 'rework', provider: result.provider, model: result.model, usage: result.usage }], usdToEur, now);
  });
  return hooks;
}

/** Accroches encore proposées pour ce post (dernière demande de l'heure, pour la révision en cours). */
export async function pendingHooks(db: Database, userId: string, postId: string, now: Date): Promise<readonly string[]> {
  return asUser(db, userId, async (trx) => {
    const post = await trx.selectFrom('posts as p').innerJoin('post_versions as v', 'v.id', 'p.current_version_id').select(['p.workspace_id', 'v.revision']).where('p.id', '=', postId).executeTakeFirst();
    if (post === undefined) return [];
    const run = await trx
      .selectFrom('generation_runs')
      .select('report')
      .where('workspace_id', '=', post.workspace_id)
      .where('kind', '=', 'on_demand')
      .where('triggered_by', '=', userId)
      .where('started_at', '>', new Date(now.getTime() - HOOKS_TTL_MINUTES * 60_000))
      .where(sql<boolean>`report->>'postId' = ${postId}`)
      .where(sql<boolean>`report->>'kind' = 'accroches'`)
      .orderBy('started_at', 'desc')
      .executeTakeFirst();
    const report = (run?.report ?? null) as { hooks?: string[]; revision?: number } | null;
    return report !== null && report.revision === post.revision && Array.isArray(report.hooks) ? report.hooks : [];
  });
}

/** Remplace le premier paragraphe par l'accroche choisie : révision du texte par la personne. */
export async function applyHook(db: Database, userId: string, postId: string, index: number, now: Date): Promise<void> {
  const hooks = await pendingHooks(db, userId, postId, now);
  const hook = hooks[index];
  if (hook === undefined) throw new RefusedError('accroche_expiree', 'Cette proposition n’est plus disponible : redemandez des accroches.');
  const post = await loadEditable(db, userId, postId);
  const paragraphs = post.body.split(/\n\s*\n/);
  const body = [hook, ...paragraphs.slice(1)].join('\n\n');
  await asUser(db, userId, async (trx) => {
    const version = await trx
      .insertInto('post_versions')
      .values({ workspace_id: post.workspace_id, post_id: post.id, revision: post.revision + 1, body, author_kind: 'user', author_user_id: userId, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.updateTable('posts').set({ current_version_id: version.id }).where('id', '=', post.id).execute();
  });
}

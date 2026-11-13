/**
 * Reprises automatiques (GEN-07, RÈG-12 à RÈG-14, REC-10), toutes les 5 minutes.
 *
 * - « À modifier » avec une note : nouvelle version du même sujet, qui applique la note en
 *   repartant du texte corrigé (RÈG-12). Sans note (données reprises de l'outil actuel) :
 *   le post attend (RÈG-23).
 * - « Refusé » : un autre sujet pour le même compte, dans l'ordre de GEN-02, en tenant
 *   compte du motif (RÈG-13). Le sujet refusé n'est pas reproposé.
 * - La reprise garde le créneau s'il est à plus de 3 heures, sinon prend le prochain créneau
 *   libre (RÈG-14). Au-delà de 3 reprises, le post sort du circuit et l'équipe le reprend
 *   à la main.
 */
import { ModelError, PROMPT_VERSION, type BriefDocument, type PostBrief, renderBrief, renderReworkBrief, writePost } from '@posts-auto/ai';
import {
  ABANDON_REASONS,
  type AbandonReason,
  type PostOrigin,
  REFUSAL_REASONS,
  type Subject,
  addMinutes,
  allocateSubjects,
  applyPostCommand,
  slotForRework,
  subjectOrigin,
} from '@posts-auto/core';
import { type Tx, asSystem, weekStartOf } from '@posts-auto/db';
import { currentEditorialLine, offerItems } from '@posts-auto/services';
import { notify } from '../notifications/recipients.ts';
import { type SubjectInfo, loadAccounts, loadGenerationData, loadOccupied, loadOtherPosts, loadSettings, subjectKey } from './load.ts';
import { type PostSource, accountContext, insertGeneratedPost, recordUsage, slotLabel } from './store.ts';
import type { GenerationDeps } from './weekly.ts';

/** GEN-07 : 3 reprises au plus (versions 2, 3 et 4), puis traitement manuel. */
export const MAX_REWORKS = 3;
export const REWORK_LEASE_MINUTES = 30;
/** Échecs de suite du fournisseur avant de passer la main à l'équipe. */
export const REWORK_MAX_ATTEMPTS = 3;
const BATCH = 5;

export interface ReworkTickReport {
  readonly reworked: readonly string[];
  readonly abandoned: readonly string[];
  readonly waiting: readonly string[];
  readonly retrying: readonly string[];
}

interface ReworkPost {
  readonly id: string;
  readonly workspace_id: string;
  readonly account_id: string;
  readonly status: 'modif' | 'refuse';
  readonly version_no: number;
  readonly decision_note: string | null;
  readonly origin: string;
  readonly scheduled_at: Date;
  readonly must_publish_by: Date | null;
  readonly is_optional: boolean;
  readonly source_note: string | null;
  readonly planning_cell_id: string | null;
  readonly subject_id: string | null;
  readonly idea_id: string | null;
  readonly event_id: string | null;
  readonly request_id: string | null;
  readonly rework_attempts: number;
  readonly body: string;
}

export async function runReworkTick(deps: GenerationDeps): Promise<ReworkTickReport> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const claimed = await asSystem(deps.db, async (trx) => {
    const rows = await trx
      .selectFrom('posts as p')
      .select('p.id')
      .where('p.status', 'in', ['modif', 'refuse'])
      .where('p.rework_attempts', '<', REWORK_MAX_ATTEMPTS)
      .where((eb) => eb.or([eb('p.rework_lease_until', 'is', null), eb('p.rework_lease_until', '<', now)]))
      .where((eb) => eb.not(eb.exists(eb.selectFrom('posts as s').select('s.id').whereRef('s.replaces_post_id', '=', 'p.id'))))
      .orderBy('p.updated_at')
      .limit(BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) await trx.updateTable('posts').set({ rework_lease_until: addMinutes(now, REWORK_LEASE_MINUTES) }).where('id', 'in', ids).execute();
    return ids;
  });

  const report = { reworked: [] as string[], abandoned: [] as string[], waiting: [] as string[], retrying: [] as string[] };
  for (const postId of claimed) report[await reworkPost(deps, postId, clock)].push(postId);
  return report;
}

/** Sort le post du circuit (statut « abandonne ») et prévient l'équipe de rédaction. */
async function abandon(trx: Tx, post: ReworkPost, reason: AbandonReason, now: Date, accountName: string): Promise<void> {
  const result = applyPostCommand({ status: post.status, hasBlockingMarkers: false }, { type: 'abandon', reason }, { kind: 'system' }, now);
  if (!result.ok) return;
  await trx.updateTable('posts').set({ status: result.status, rework_lease_until: null }).where('id', '=', post.id).execute();
  await trx
    .insertInto('post_status_history')
    .values({ workspace_id: post.workspace_id, post_id: post.id, from_status: post.status, to_status: result.status, actor_kind: 'system', reason: ABANDON_REASONS[reason], at: now })
    .execute();
  await notifyEditors(trx, post, 'reprise_manuelle', { postId: post.id, accountName, reason: ABANDON_REASONS[reason] });
}

async function notifyEditors(trx: Tx, post: ReworkPost, kind: string, payload: Record<string, unknown>): Promise<void> {
  const team = await trx.selectFrom('workspace_members').select('user_id').where('workspace_id', '=', post.workspace_id).where('role', 'in', ['admin', 'editor']).execute();
  await notify(trx, [...new Set(team.map((t) => t.user_id))], post.workspace_id, kind, { workspaceId: post.workspace_id, ...payload }, ['email', 'in_app']);
}

/** Documents du sujet d'origine d'un post (pour une reprise « à modifier »). */
async function sourceOf(trx: Tx, post: ReworkPost): Promise<{ documents: BriefDocument[]; links: string[] }> {
  if (post.idea_id !== null) {
    const idea = await trx.selectFrom('ideas').select(['title', 'details', 'link']).where('id', '=', post.idea_id).executeTakeFirst();
    if (idea) return { documents: [{ type: 'idee', id: 'idee', title: idea.title, link: idea.link, content: [idea.title, idea.details].filter(Boolean).join('\n') }], links: idea.link ? [idea.link] : [] };
  }
  if (post.event_id !== null) {
    const event = await trx.selectFrom('events').select(['title', 'starts_on', 'details', 'link']).where('id', '=', post.event_id).executeTakeFirst();
    if (event) return { documents: [{ type: 'evenement', id: 'evenement', title: event.title, link: event.link, content: [`${event.title}, le ${event.starts_on}.`, event.details].filter(Boolean).join('\n') }], links: event.link ? [event.link] : [] };
  }
  if (post.request_id !== null) {
    const request = await trx.selectFrom('post_requests').select(['raw_text', 'details', 'links']).where('id', '=', post.request_id).executeTakeFirst();
    if (request) return { documents: [{ type: 'demande', id: 'demande', content: [request.raw_text, request.details].filter(Boolean).join('\n\n') }], links: request.links };
  }
  if (post.planning_cell_id !== null) {
    const cell = await trx.selectFrom('planning_cells').select('content').where('id', '=', post.planning_cell_id).executeTakeFirst();
    if (cell) return { documents: [{ type: 'case', id: 'case', content: cell.content }], links: [] };
  }
  if (post.subject_id !== null) {
    const subject = await trx.selectFrom('subject_bank').select(['subject', 'angle']).where('id', '=', post.subject_id).executeTakeFirst();
    if (subject) return { documents: [{ type: 'banque', id: 'banque', content: [subject.subject, subject.angle && `Angle : ${subject.angle}`].filter(Boolean).join('\n') }], links: [] };
  }
  return { documents: [], links: [] };
}

/** Le sujet refusé n'est pas reproposé : case mise de côté, idée écartée (RÈG-13). */
async function retireRefusedSubject(trx: Tx, post: ReworkPost, reasonLabel: string, now: Date): Promise<void> {
  if (post.planning_cell_id !== null) {
    await trx
      .updateTable('planning_cells')
      .set({ set_aside_at: now, set_aside_reason: `Sujet refusé par le titulaire : ${reasonLabel}`.slice(0, 500) })
      .where('id', '=', post.planning_cell_id)
      .where('set_aside_at', 'is', null)
      .execute();
  }
  if (post.idea_id !== null) {
    await trx.updateTable('ideas').set({ status: 'dismissed', followup: `Post refusé par le titulaire : ${reasonLabel}`.slice(0, 1000) }).where('id', '=', post.idea_id).execute();
  }
}

function refusalLabel(note: string | null): string {
  const [code, ...rest] = (note ?? '').split(' : ');
  const label = REFUSAL_REASONS[code as keyof typeof REFUSAL_REASONS] ?? code ?? 'motif non précisé';
  return rest.length > 0 ? `${label} (${rest.join(' : ')})` : label;
}

async function reworkPost(deps: GenerationDeps, postId: string, clock: () => Date): Promise<'reworked' | 'abandoned' | 'waiting' | 'retrying'> {
  const { db, model } = deps;
  const now = clock();
  const post = await asSystem(db, (trx) =>
    trx
      .selectFrom('posts as p')
      .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select([
        'p.id',
        'p.workspace_id',
        'p.account_id',
        'p.status',
        'p.version_no',
        'p.decision_note',
        'p.origin',
        'p.scheduled_at',
        'p.must_publish_by',
        'p.is_optional',
        'p.source_note',
        'p.planning_cell_id',
        'p.subject_id',
        'p.idea_id',
        'p.event_id',
        'p.request_id',
        'p.rework_attempts',
        'v.body',
      ])
      .where('p.id', '=', postId)
      .executeTakeFirstOrThrow(),
  ) as ReworkPost;
  const release = () => asSystem(db, (trx) => trx.updateTable('posts').set({ rework_lease_until: null }).where('id', '=', postId).execute());

  // RÈG-23 : sans note, la reprise attend la note du titulaire.
  if (post.status === 'modif' && (post.decision_note ?? '').trim() === '') {
    await release();
    return 'waiting';
  }
  const workspaceId = post.workspace_id;
  const settings = await asSystem(db, (trx) => loadSettings(trx, workspaceId));
  const [account] = await asSystem(db, (trx) => loadAccounts(trx, workspaceId, now, [post.account_id]));
  const accountName = account?.profile.displayName ?? 'Compte';

  if (post.version_no >= 1 + MAX_REWORKS || account === undefined) {
    await asSystem(db, (trx) => abandon(trx, post, account === undefined ? 'compte_deconnecte' : 'trop_de_reprises', now, accountName));
    return 'abandoned';
  }

  // RÈG-14 : créneau de la reprise.
  const occupied = await asSystem(db, (trx) => loadOccupied(trx, workspaceId, now, addMinutes(now, 15 * 24 * 60)));
  const slot = slotForRework(
    { postId: post.id, accountId: post.account_id, scheduledAt: post.scheduled_at, ...(post.must_publish_by !== null && post.status === 'modif' && { mustPublishBy: post.must_publish_by }) },
    now,
    { calendar: settings.calendar, rules: settings.slotRules, occupied },
  );
  if (slot.kind === 'abandon' || slot.kind === 'depart_now') {
    await asSystem(db, (trx) => abandon(trx, post, slot.kind === 'abandon' ? slot.reason : 'plus_de_creneau', now, accountName));
    return 'abandoned';
  }
  const at = slot.at;
  const weekStart = weekStartOf(at, settings.calendar);

  // Sujet de la reprise.
  let origin = post.origin as PostOrigin;
  let source: PostSource = {
    ...(post.planning_cell_id && { planningCellId: post.planning_cell_id }),
    ...(post.subject_id && { subjectId: post.subject_id }),
    ...(post.idea_id && { ideaId: post.idea_id }),
    ...(post.event_id && { eventId: post.event_id }),
    ...(post.request_id && { requestId: post.request_id }),
  };
  let summary = post.source_note ?? 'Reprise';
  let mustPublishBy = post.must_publish_by;
  let task: string;
  let documents: BriefDocument[] = [];
  const refusal = post.status === 'refuse' ? refusalLabel(post.decision_note) : null;

  if (post.status === 'modif') {
    const original = await asSystem(db, (trx) => sourceOf(trx, post));
    documents = original.documents;
    const brief: PostBrief = { scheduledAtLabel: slotLabel(at, settings.calendar.timeZone), originLabel: `reprise n°${post.version_no} demandée par le titulaire`, subject: summary, documents, links: original.links };
    task = renderReworkBrief(brief, post.body, post.decision_note ?? '');
  } else {
    // RÈG-13 : autre sujet, dans l'ordre de GEN-02, pour ce compte et la semaine de la reprise.
    const data = await asSystem(db, (trx) => loadGenerationData(trx, workspaceId, now));
    const refusedKeys = new Set([post.planning_cell_id && `planning_cell:${post.planning_cell_id}`, post.idea_id && `idea:${post.idea_id}`, post.subject_id && `bank:${post.subject_id}`, post.event_id && `event:${post.event_id}`]);
    let candidates = data.subjects.filter((s) => !refusedKeys.has(subjectKey(s)));
    let chosen: { subject: Subject | null; info: SubjectInfo | null; mustPublishBy: Date | null } = { subject: null, info: null, mustPublishBy: null };
    for (let guard = 0; guard < 20; guard += 1) {
      const first = allocateSubjects({
        now,
        weeks: [weekStart],
        accounts: [{ id: post.account_id, postsPerWeek: 1, optionalPerWeek: 0, usualSlots: [] }],
        subjects: candidates,
        windowPosts: [],
        slots: { calendar: settings.calendar, rules: settings.slotRules, occupied: [] },
      }).assignments[0];
      const subject = first?.subject ?? null;
      // Un sujet daté doit pouvoir partir au créneau de la reprise.
      if (subject !== null && first?.mustPublishBy && at.getTime() >= first.mustPublishBy.getTime()) {
        candidates = candidates.filter((s) => s !== subject);
        continue;
      }
      chosen = { subject, info: subject === null ? null : (data.subjectInfo.get(subjectKey(subject)) ?? null), mustPublishBy: first?.mustPublishBy ?? null };
      break;
    }
    origin = chosen.subject === null ? 'ai_idea' : subjectOrigin(chosen.subject);
    source = chosen.info?.source ?? {};
    summary = chosen.info?.title ?? 'Sujet choisi par l’IA';
    mustPublishBy = chosen.mustPublishBy;
    documents = [...(chosen.info?.documents ?? [])];
    const brief: PostBrief = {
      scheduledAtLabel: slotLabel(at, settings.calendar.timeZone),
      originLabel: `reprise après refus (${refusal})`,
      subject: chosen.info?.title ?? null,
      documents,
      links: chosen.info?.links ?? [],
    };
    task = `${renderBrief(brief)}\n\nLe post précédent prévu sur ce créneau a été refusé par le titulaire. Motif : ${refusal}. Sujet refusé, à ne pas reprendre : « ${post.source_note ?? 'non résumé'} ». Tiens compte du motif.`;
  }

  try {
    const editorial = await asSystem(db, (trx) => currentEditorialLine(trx, workspaceId));
    const offer = await asSystem(db, (trx) => offerItems(trx, workspaceId));
    const otherPosts = (await asSystem(db, (trx) => loadOtherPosts(trx, workspaceId, now))).filter((p) => p.postId !== post.id);
    const outcome = await writePost(model, {
      context: accountContext(settings.name, editorial, editorial.rules, offer, account),
      task,
      purpose: 'rework',
      rules: editorial.rules,
      bannedPhrases: editorial.bannedPhrases,
      externalContents: [...documents.map((d) => d.content), ...(post.status === 'modif' ? [post.decision_note ?? ''] : [])],
      otherPosts,
    });
    const newId = await asSystem(db, async (trx) => {
      const run = await trx
        .insertInto('generation_runs')
        .values({ workspace_id: workspaceId, kind: 'rework', status: 'done', started_at: now, finished_at: clock(), model: model.model, prompt_version: PROMPT_VERSION, report: JSON.stringify({ replacedPostId: post.id, remaining: outcome.report.remaining, suspiciousInstructions: outcome.report.suspiciousInstructions }) })
        .returning('id')
        .executeTakeFirstOrThrow();
      // L'ancien post laisse sa place à sa reprise (section 6.1 : modif/refuse → remplace).
      const replaced = applyPostCommand({ status: post.status, hasBlockingMarkers: false }, { type: 'replace' }, { kind: 'system' }, now);
      if (!replaced.ok) throw new Error(`Transition impossible : ${replaced.error}`);
      await trx.updateTable('posts').set({ status: 'remplace', rework_lease_until: null }).where('id', '=', post.id).execute();
      await trx
        .insertInto('post_status_history')
        .values({ workspace_id: workspaceId, post_id: post.id, from_status: post.status, to_status: 'remplace', actor_kind: 'system', reason: `Remplacé par sa reprise n°${post.version_no + 1} (GEN-07)`, at: now })
        .execute();
      if (refusal !== null) await retireRefusedSubject(trx, post, refusal, now);
      const id = await insertGeneratedPost(
        trx,
        {
          workspaceId,
          accountId: post.account_id,
          weekStart,
          at,
          mustPublishBy,
          isOptional: post.is_optional,
          origin,
          source,
          runId: run.id,
          body: outcome.body,
          summary,
          replacesPostId: post.id,
          versionNo: post.version_no + 1,
          reason: post.status === 'modif' ? 'Reprise rédigée par l’IA : note du titulaire appliquée (GEN-07)' : `Reprise rédigée par l’IA après refus : autre sujet (RÈG-13)`,
        },
        clock(),
      );
      if (source.ideaId !== undefined && refusal !== null) {
        await trx.updateTable('ideas').set({ status: 'used', followup: `Post rédigé pour ${accountName} après le refus d’un autre sujet.` }).where('id', '=', source.ideaId).execute();
      }
      // Les photos du post suivent sa reprise « à modifier » (même sujet).
      if (post.status === 'modif') {
        const media = await trx.selectFrom('post_media').select(['asset_id', 'position', 'alt_text']).where('post_id', '=', post.id).orderBy('position').execute();
        for (const m of media) await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: id, asset_id: m.asset_id, position: m.position, alt_text: m.alt_text }).execute();
      }
      await recordUsage(trx, { workspaceId, accountId: post.account_id, runId: run.id, postId: id, calls: outcome.calls, usdToEur: deps.usdToEur ?? 0.86, countsInQuota: false }, clock());
      const delegates = await trx.selectFrom('account_delegates').select('user_id').where('account_id', '=', post.account_id).execute();
      const people = [...new Set([account.holderUserId, ...delegates.map((d) => d.user_id)].filter((p): p is string => p !== null))];
      await notify(trx, people, workspaceId, 'nouvelle_version', { postId: id, accountName, scheduledAt: at.toISOString(), refused: refusal !== null }, ['email', 'in_app']);
      return id;
    });
    return newId ? 'reworked' : 'retrying';
  } catch (error) {
    const attempts = post.rework_attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    const retryable = error instanceof ModelError ? error.retryable : true;
    await asSystem(db, async (trx) => {
      await trx.updateTable('posts').set({ rework_lease_until: null, rework_attempts: retryable ? attempts : REWORK_MAX_ATTEMPTS, last_error: message }).where('id', '=', postId).execute();
      if (!retryable || attempts >= REWORK_MAX_ATTEMPTS) await notifyEditors(trx, post, 'reprise_manuelle', { postId: post.id, accountName, reason: message });
    });
    return 'retrying';
  }
}


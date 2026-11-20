/**
 * Rédaction hebdomadaire (GEN-01 à GEN-06, PLA-04, REC-03, REC-04, décision 0005).
 *
 * 1. Une seule rédaction en cours par espace (bail en base) ; une rédaction interrompue
 *    est déclarée en échec quand son bail expire, et la suivante repart de l'état de la base.
 * 2. Le code affecte les sujets aux créneaux (allocateSubjects) ; l'IA rédige chaque post,
 *    un second passage le vérifie (writePost).
 * 3. Chaque post est déposé « à valider » avec son origine ; un post remplacé (GEN-03)
 *    libère son créneau et son sujet repart en réserve.
 * 4. Le rapport (sujets non placés, corrections, consignes cachées, coût) est enregistré,
 *    et l'équipe est prévenue.
 */
import { ModelError, PROMPT_VERSION, type PostBrief, type TextModel, renderBrief, writePost } from '@posts-auto/ai';
import { type Assignment, type Subject, allocateSubjects, isoWeekNumber, lastCronOccurrence, parseCron } from '@posts-auto/core';
import { type Database, type Tx, asSystem, weekStartOf } from '@posts-auto/db';
import { remainingTrialPosts, trialLimitReason, trialStateForWorkspace } from '@posts-auto/services';
import type { ImageGenerator } from '@posts-auto/visuals';
import type { MediaStore } from '../media/media-store.ts';
import { notify } from '../notifications/recipients.ts';
import { storeVisual } from '../visuals/prepare.ts';
import { type VisualSummary, openVisualSession, photoPlan, tryPrepareVisual } from '../visuals/session.ts';
import { type AccountData, type GenerationData, loadGenerationData, subjectKey } from './load.ts';
import { materializeRecurringEvents } from './recurring-events.ts';
import { accountContext, dayLabel, insertGeneratedPost, recordUsage, slotLabel } from './store.ts';

export interface GenerationDeps {
  readonly db: Database;
  readonly model: TextModel;
  readonly clock?: () => Date;
  /** Conversion du coût en euros (AI_USD_TO_EUR). */
  readonly usdToEur?: number;
  /** Rédactions de posts menées en parallèle dans un espace. */
  readonly concurrency?: number;
  /** Stockage des images : sans lui, les posts sont déposés sans visuel (1c). */
  readonly media?: MediaStore;
  /** Générateur d'images (VIS-05) ; sans lui, photo de la médiathèque ou visuel texte. */
  readonly images?: ImageGenerator | null;
}

/** Durée du bail d'une rédaction, prolongé à chaque post. */
export const GENERATION_LEASE_MINUTES = 30;
/** Après 3 échecs de suite du fournisseur, la rédaction s'arrête : elle reprendra au passage suivant. */
const MAX_CONSECUTIVE_PROVIDER_ERRORS = 3;

export interface PostReport {
  readonly postId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly origin: string;
  readonly subject: string;
  readonly at: string;
  readonly replaced: string | null;
  readonly corrected: readonly string[];
  readonly remaining: readonly string[];
  readonly warnings: readonly string[];
  readonly suspiciousInstructions: readonly string[];
  /** Visuel du post (1c) ; absent quand les visuels ne sont pas activés. */
  readonly visual?: VisualSummary;
}

export interface RunReport {
  readonly weeks: readonly string[];
  readonly posts: readonly PostReport[];
  readonly unplaced: readonly { readonly kind: string; readonly label: string; readonly accountName: string | null; readonly weekStart: string | null; readonly reason: string }[];
  readonly errors: readonly { readonly accountName: string; readonly subject: string; readonly message: string }[];
  readonly costUsd: number;
  readonly model: string;
}

export interface WeeklyOutcome {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly skipped?: 'deja_en_cours';
  readonly created: number;
  readonly replaced: number;
  readonly unplaced: number;
  readonly errors: number;
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

/** Ouvre la rédaction ; `null` si une autre est en cours (bail encore valide). */
async function openRun(db: Database, workspaceId: string, weeks: readonly string[], triggeredBy: string | null, model: TextModel, promptVersion: string, now: Date): Promise<string | null> {
  await asSystem(db, (trx) =>
    trx
      .updateTable('generation_runs')
      .set({ status: 'failed', finished_at: now, error: 'Interrompue : reprise par une nouvelle rédaction.' })
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'weekly')
      .where('status', '=', 'running')
      .where('lease_until', '<', now)
      .execute(),
  );
  // Transaction à part : une violation d'unicité annule la transaction qui la subit.
  try {
    return await asSystem(db, async (trx) => {
      const row = await trx
        .insertInto('generation_runs')
        .values({
          workspace_id: workspaceId,
          kind: 'weekly',
          weeks: [...weeks],
          status: 'running',
          lease_until: new Date(now.getTime() + GENERATION_LEASE_MINUTES * 60_000),
          started_at: now,
          model: model.model,
          prompt_version: promptVersion,
          triggered_by: triggeredBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.updateTable('workspaces').set({ generation_requested_at: null }).where('id', '=', workspaceId).execute();
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'generation_runs_one_weekly_idx')) return null;
    throw error;
  }
}

function originLabel(assignment: Assignment): string {
  const subject = assignment.subject;
  if (subject === null) return 'sujet choisi par l’IA, faute d’autre matière cette semaine';
  switch (subject.kind) {
    case 'planning_cell':
      return `case du planning, semaine ${isoWeekNumber(subject.weekStart)}`;
    case 'event':
      return 'relais d’un événement du planning';
    case 'idea':
      return subject.origin === 'team' ? 'idée proposée par l’équipe' : 'réserve : sujet mis de côté lors d’une rédaction précédente';
    case 'bank':
      return 'banque de sujets du compte';
  }
}

function deadlineLabel(subject: Subject | null): string | null {
  if (subject?.kind === 'event') return `avant l’événement du ${dayLabel(subject.startsOn)}`;
  if (subject?.kind === 'idea' && subject.eventOn !== null) return `avant l’événement du ${dayLabel(subject.eventOn)}`;
  return null;
}

/**
 * GEN-03 : remplace le post « à valider » et met son sujet en réserve (IDE-02). Rend `false`
 * si le post n'est plus remplaçable (validé, corrigé, refusé entre-temps).
 */
async function replacePost(trx: Tx, postId: string, accountId: string, now: Date): Promise<boolean> {
  const old = await trx
    .selectFrom('posts')
    .select(['id', 'workspace_id', 'status', 'origin', 'idea_id', 'source_note'])
    .where('id', '=', postId)
    .forUpdate()
    .executeTakeFirst();
  const edited = await trx
    .selectFrom('post_versions')
    .select('id')
    .where('post_id', '=', postId)
    .where((w) => w.or([w('author_kind', '=', 'user'), w('author_user_id', 'is not', null)]))
    .executeTakeFirst();
  if (old === undefined || old.status !== 'a_valider' || edited !== undefined) return false;
  await trx.updateTable('posts').set({ status: 'remplace' }).where('id', '=', postId).execute();
  await trx
    .insertInto('post_status_history')
    .values({ workspace_id: old.workspace_id, post_id: postId, from_status: 'a_valider', to_status: 'remplace', actor_kind: 'system', reason: 'Remplacé par un sujet prioritaire apparu depuis sa rédaction (GEN-03)', at: now })
    .execute();
  const date = now.toISOString().slice(0, 10);
  if (old.idea_id !== null) {
    await trx.updateTable('ideas').set({ status: 'kept', followup: `Post remplacé le ${date} par un sujet prioritaire : l’idée sera reprise lors d’une prochaine rédaction.` }).where('id', '=', old.idea_id).execute();
  } else if (old.origin === 'ai_idea' || old.origin === 'external_source') {
    const reserve = await trx
      .insertInto('ideas')
      .values({
        workspace_id: old.workspace_id,
        title: (old.source_note ?? 'Sujet mis en réserve').slice(0, 300),
        origin: 'ai_reserve',
        from_post_id: postId,
        followup: `Mis en réserve le ${date} : remplacé par un sujet prioritaire.`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('idea_accounts').values({ idea_id: reserve.id, account_id: accountId, workspace_id: old.workspace_id }).execute();
  }
  // Ligne de banque ou case : le sujet redevient libre et sera repris à son rang.
  return true;
}

async function heartbeat(db: Database, runId: string, now: Date): Promise<void> {
  await asSystem(db, (trx) => trx.updateTable('generation_runs').set({ lease_until: new Date(now.getTime() + GENERATION_LEASE_MINUTES * 60_000) }).where('id', '=', runId).execute());
}

/** Destinataires : titulaires et délégués des comptes servis ; équipe de rédaction (admins, éditeurs, propriétaires). */
async function notifyTeam(trx: Tx, workspaceId: string, report: RunReport, runId: string, accountIds: readonly string[]): Promise<void> {
  if (accountIds.length > 0) {
    const holders = await trx.selectFrom('social_accounts').select('holder_user_id').where('id', 'in', [...accountIds]).execute();
    const delegates = await trx.selectFrom('account_delegates').select('user_id').where('account_id', 'in', [...accountIds]).execute();
    const people = [...new Set([...holders.map((h) => h.holder_user_id), ...delegates.map((d) => d.user_id)].filter((id): id is string => id !== null))];
    // Le récapitulatif du lundi (VAL-05) fait office d'e-mail : ici, l'application seulement.
    await notify(trx, people, workspaceId, 'posts_prets', { workspaceId, count: report.posts.length }, ['in_app']);
  }
  const team = await trx
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('role', 'in', ['admin', 'editor'])
    .execute();
  const owners = await trx
    .selectFrom('org_members as o')
    .innerJoin('workspaces as w', 'w.org_id', 'o.org_id')
    .select('o.user_id')
    .where('w.id', '=', workspaceId)
    .where('o.role', '=', 'owner')
    .execute();
  const editors = [...new Set([...team, ...owners].map((r) => r.user_id))];
  await notify(
    trx,
    editors,
    workspaceId,
    'generation_terminee',
    {
      workspaceId,
      runId,
      created: report.posts.length,
      withMarkers: report.posts.filter((p) => p.remaining.length > 0).length,
      unplaced: report.unplaced.length,
      suspicious: report.posts.reduce((n, p) => n + p.suspiciousInstructions.length, 0),
      errors: report.errors.length,
    },
    ['email', 'in_app'],
  );
}

/** Exécute une tâche par élément, `limit` à la fois. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await work(items[index] as T, index);
    }
  });
  await Promise.all(runners);
}

export async function runWeeklyGeneration(deps: GenerationDeps, workspaceId: string, options: { triggeredBy?: string | null } = {}): Promise<WeeklyOutcome> {
  const { db, model } = deps;
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  // EDI-08 : occurrences à venir des rendez-vous récurrents, relayées comme des événements.
  await materializeRecurringEvents(db, now, workspaceId);
  const data: GenerationData = await asSystem(db, (trx) => loadGenerationData(trx, workspaceId, now));
  const runId = await openRun(db, workspaceId, data.weeks, options.triggeredBy ?? null, model, PROMPT_VERSION, now);
  if (runId === null) return { workspaceId, runId: null, skipped: 'deja_en_cours', created: 0, replaced: 0, unplaced: 0, errors: 0 };

  const { settings, editorial } = data;
  const rules = editorial.rules;
  const accounts = new Map<string, AccountData>(data.accounts.map((a) => [a.profile.accountId, a]));
  const nameOf = (id: string | null) => (id === null ? null : (accounts.get(id)?.profile.displayName ?? 'Compte'));
  const allocation = allocateSubjects({
    now,
    weeks: data.weeks,
    accounts: data.accounts.map((a) => ({ id: a.profile.accountId, postsPerWeek: a.profile.postsPerWeek, optionalPerWeek: a.profile.optionalPerWeek, usualSlots: a.profile.usualSlots })),
    subjects: data.subjects,
    windowPosts: data.windowPosts,
    slots: { calendar: settings.calendar, rules: settings.slotRules, occupied: [...data.occupied] },
  });

  // ONB-06 : pendant l'essai gratuit, la rédaction s'arrête à 10 posts et à la fin de l'essai.
  // Les premiers créneaux sont servis ; les autres sujets sont signalés au rapport.
  const trial = await asSystem(db, (trx) => trialStateForWorkspace(trx, workspaceId, now));
  const allowed = remainingTrialPosts(trial);
  const kept = new Set(allowed === null ? allocation.assignments : [...allocation.assignments].sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, allowed));
  const assignments = allocation.assignments.filter((a) => kept.has(a));
  const cutByTrial = allocation.assignments.filter((a) => !kept.has(a));

  const contexts = new Map<string, string>();
  const written: { postId: string; text: string }[] = [];
  const posts: PostReport[] = [];
  const errors: { accountName: string; subject: string; message: string }[] = [];
  let costUsd = 0;
  let consecutiveProviderErrors = 0;
  let aborted: string | null = null;
  // 1c : visuels préparés avec chaque post ; alternance photo / texte décidée d'avance, compte par compte.
  const visuals = await openVisualSession(deps, workspaceId, [...new Set(assignments.map((a) => a.accountId))], now);
  const withPhoto = visuals === null ? new Map<Assignment, boolean>() : photoPlan(visuals, assignments);
  // GEN-09 : chaque créneau laissé au choix de l'IA reçoit un article de veille différent, qu'elle peut reprendre.
  const freeSlots = assignments.filter((a) => a.subject === null);
  const articleFor = new Map(freeSlots.flatMap((a, i) => (data.articles[i] ? [[a, data.articles[i]] as const] : [])));

  await pool(assignments, deps.concurrency ?? 3, async (assignment) => {
    if (aborted !== null) return;
    const account = accounts.get(assignment.accountId);
    if (account === undefined) return;
    const info = assignment.subject === null ? null : data.subjectInfo.get(subjectKey(assignment.subject));
    const article = articleFor.get(assignment) ?? null;
    const articleDocId = article === null ? null : `article-${article.id.slice(0, 8)}`;
    const sameSubject =
      assignment.subject === null
        ? []
        : assignments
            .filter((other) => other !== assignment && other.subject !== null && subjectKey(other.subject) === subjectKey(assignment.subject as Subject))
            .map((other) => nameOf(other.accountId) ?? 'Compte');
    const brief: PostBrief = {
      scheduledAtLabel: slotLabel(assignment.at, settings.calendar.timeZone),
      originLabel:
        article === null
          ? originLabel(assignment)
          : `${originLabel(assignment)} ; un article de veille est proposé : s’il est utile à ce compte, tu peux en tirer le post en citant son lien en fin de texte et en indiquant « ${articleDocId} » dans sourcesUsed`,
      subject: info?.title ?? null,
      documents:
        article === null
          ? (info?.documents ?? [])
          : [{ type: 'article', id: articleDocId as string, title: article.title, link: article.link, content: [`${article.title} (source : ${article.sourceLabel})`, article.summary].filter(Boolean).join('\n') }],
      links: info?.links ?? [],
      deadlineLabel: deadlineLabel(assignment.subject),
      otherAccountsOnSubject: sameSubject,
    };
    let context = contexts.get(assignment.accountId);
    if (context === undefined) {
      context = accountContext(settings.name, editorial, rules, data.offer, account);
      contexts.set(assignment.accountId, context);
    }
    const subjectLabel = info?.title ?? 'sujet au choix de l’IA';
    try {
      const outcome = await writePost(model, {
        context,
        task: renderBrief(brief),
        purpose: 'write',
        rules,
        bannedPhrases: editorial.bannedPhrases,
        externalContents: brief.documents.map((d) => d.content),
        otherPosts: [...data.otherPosts, ...written],
      });
      consecutiveProviderErrors = 0;
      const usedArticle = article !== null && outcome.report.sourcesUsed.includes(articleDocId as string) ? article : null;
      const origin = usedArticle === null ? assignment.origin : 'external_source';
      const summary = usedArticle?.title ?? info?.title ?? outcome.summary;
      const visual =
        visuals === null
          ? null
          : await tryPrepareVisual(visuals, { accountId: assignment.accountId, postText: outcome.body, summary, withPhoto: withPhoto.get(assignment) ?? false });
      const stored = await asSystem(db, async (trx) => {
        if (assignment.replacesPostId !== null && !(await replacePost(trx, assignment.replacesPostId, assignment.accountId, now))) return null;
        const postId = await insertGeneratedPost(
          trx,
          {
            workspaceId,
            accountId: assignment.accountId,
            weekStart: weekStartOf(assignment.at, settings.calendar),
            at: assignment.at,
            mustPublishBy: assignment.mustPublishBy,
            isOptional: assignment.isOptional,
            origin,
            source: info?.source ?? {},
            runId,
            body: outcome.body,
            summary,
            reason: `Rédigé par l’IA (${usedArticle === null ? originLabel(assignment) : `article de veille « ${usedArticle.title} »`})`,
          },
          now,
        );
        if (usedArticle !== null) await trx.updateTable('source_items').set({ used_post_id: postId }).where('id', '=', usedArticle.id).execute();
        if (assignment.subject?.kind === 'idea') {
          await trx
            .updateTable('ideas')
            .set({ status: 'used', followup: `Post rédigé pour ${account.profile.displayName ?? 'le compte'}, ${brief.scheduledAtLabel}.` })
            .where('id', '=', assignment.subject.id)
            .execute();
        }
        let cost = await recordUsage(trx, { workspaceId, accountId: assignment.accountId, runId, postId, calls: outcome.calls, usdToEur: deps.usdToEur ?? 0.86, countsInQuota: true }, now);
        if (visual?.prepared) {
          cost += await storeVisual(trx, visual.prepared, { workspaceId, accountId: assignment.accountId, postId, runId, usdToEur: deps.usdToEur ?? 0.86 }, now);
        }
        return { postId, cost };
      });
      if (stored === null) {
        errors.push({ accountName: nameOf(assignment.accountId) ?? 'Compte', subject: subjectLabel, message: 'Remplacement annulé : le post en place a été validé ou corrigé entre-temps.' });
        return;
      }
      costUsd += stored.cost;
      written.push({ postId: stored.postId, text: outcome.body });
      posts.push({
        postId: stored.postId,
        accountId: assignment.accountId,
        accountName: nameOf(assignment.accountId) ?? 'Compte',
        origin,
        subject: summary,
        at: assignment.at.toISOString(),
        replaced: assignment.replacesPostId,
        corrected: outcome.report.corrected,
        remaining: outcome.report.remaining,
        warnings: outcome.report.warnings,
        suspiciousInstructions: outcome.report.suspiciousInstructions,
        ...(visual !== null && { visual: visual.summary }),
      });
      await heartbeat(db, runId, clock());
    } catch (error) {
      if (error instanceof ModelError && error.retryable) {
        consecutiveProviderErrors += 1;
        if (consecutiveProviderErrors >= MAX_CONSECUTIVE_PROVIDER_ERRORS) aborted = error.message;
      }
      const message = isUniqueViolation(error, 'posts_one_per_slot_idx') ? 'Créneau pris entre-temps : sujet repris à la prochaine rédaction.' : error instanceof Error ? error.message : String(error);
      errors.push({ accountName: nameOf(assignment.accountId) ?? 'Compte', subject: subjectLabel, message });
    }
  });

  const report: RunReport = {
    weeks: data.weeks,
    posts,
    unplaced: [
      ...allocation.unplaced.map((u) => ({
        kind: u.subject?.kind ?? 'rythme',
        label: u.subject === null ? 'Créneau du rythme du compte' : (data.subjectInfo.get(subjectKey(u.subject))?.title ?? ''),
        accountName: nameOf(u.accountId),
        weekStart: u.weekStart,
        reason: u.reason,
      })),
      ...cutByTrial.map((a) => ({
        kind: a.subject?.kind ?? 'rythme',
        label: a.subject === null ? 'Créneau du rythme du compte' : (data.subjectInfo.get(subjectKey(a.subject))?.title ?? ''),
        accountName: nameOf(a.accountId),
        weekStart: weekStartOf(a.at, settings.calendar),
        reason: trialLimitReason(trial),
      })),
    ],
    errors,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    model: model.model,
  };
  await asSystem(db, async (trx) => {
    await trx
      .updateTable('generation_runs')
      .set({ status: aborted === null ? 'done' : 'failed', finished_at: clock(), lease_until: null, report: JSON.stringify(report), error: aborted })
      .where('id', '=', runId)
      .execute();
    await notifyTeam(trx, workspaceId, report, runId, [...new Set(posts.map((p) => p.accountId))]);
  });
  return { workspaceId, runId, created: posts.length, replaced: posts.filter((p) => p.replaced !== null).length, unplaced: report.unplaced.length, errors: errors.length };
}

/**
 * Espaces dont la rédaction est due : demandée depuis l'application, ou échéance de
 * `generation_cron` passée sans rédaction depuis (si la rédaction automatique est activée).
 */
export async function dueWorkspaces(db: Database, now: Date): Promise<string[]> {
  const rows = await asSystem(db, (trx) =>
    trx
      .selectFrom('workspaces as w')
      .select((eb) => [
        'w.id',
        'w.timezone',
        'w.generation_cron',
        'w.auto_generation',
        'w.generation_requested_at',
        eb
          .selectFrom('generation_runs as r')
          .select((sub) => sub.fn.max('r.started_at').as('last'))
          .whereRef('r.workspace_id', '=', 'w.id')
          .where('r.kind', '=', 'weekly')
          .as('last_run'),
      ])
      .where('w.status', '=', 'active')
      .execute(),
  );
  const due: string[] = [];
  for (const row of rows) {
    const last = row.last_run === null ? 0 : new Date(row.last_run as unknown as string | Date).getTime();
    if (row.generation_requested_at !== null && row.generation_requested_at.getTime() > last) {
      due.push(row.id);
      continue;
    }
    if (!row.auto_generation) continue;
    const schedule = parseCron(row.generation_cron);
    const occurrence = schedule === null ? null : lastCronOccurrence(schedule, now, row.timezone);
    if (occurrence !== null && occurrence.getTime() > last) due.push(row.id);
  }
  return due;
}

/** Passe de la tâche « rédaction » : chaque espace dû, l'un après l'autre. */
export async function runGenerationTick(deps: GenerationDeps): Promise<{ runs: WeeklyOutcome[] }> {
  const now = (deps.clock ?? (() => new Date()))();
  const runs: WeeklyOutcome[] = [];
  for (const workspaceId of await dueWorkspaces(deps.db, now)) runs.push(await runWeeklyGeneration(deps, workspaceId));
  return { runs };
}

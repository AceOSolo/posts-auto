/**
 * Pilotage de la rédaction par l'équipe (GEN-01, GEN-05, GEN-11) : lancer une rédaction,
 * activer la rédaction automatique, consulter les rapports et le coût de l'IA.
 *
 * La rédaction elle-même est faite par la tâche de fond (décision 0005) : l'application
 * ne fait que noter la demande.
 */
import { parseCron } from '@posts-auto/core';
import { type Database, asUser } from '@posts-auto/db';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

export interface RunSummary {
  readonly id: string;
  readonly kind: 'weekly' | 'request' | 'rework' | 'on_demand';
  readonly status: 'running' | 'done' | 'failed';
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly created: number;
  readonly withMarkers: number;
  readonly unplaced: number;
  readonly errors: number;
  readonly costUsd: number;
  readonly error: string | null;
}

export interface GenerationStatus {
  readonly canLaunch: boolean;
  readonly canConfigure: boolean;
  readonly autoGeneration: boolean;
  readonly cron: string;
  readonly requestedAt: Date | null;
  readonly running: boolean;
  readonly runs: readonly RunSummary[];
  /** GEN-11 : coût de l'IA depuis le début du mois (UTC), et posts comptés dans le quota. */
  readonly month: { readonly costUsd: number; readonly costEur: number; readonly countedPosts: number };
}

interface ReportShape {
  posts?: { remaining?: unknown[] }[];
  unplaced?: unknown[];
  errors?: unknown[];
  costUsd?: number;
}

function summarize(row: { id: string; kind: string; status: string; started_at: Date; finished_at: Date | null; report: unknown; error: string | null }): RunSummary {
  const report = (row.report ?? {}) as ReportShape;
  const posts = Array.isArray(report.posts) ? report.posts : [];
  return {
    id: row.id,
    kind: row.kind as RunSummary['kind'],
    status: row.status as RunSummary['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    created: posts.length,
    withMarkers: posts.filter((p) => Array.isArray(p.remaining) && p.remaining.length > 0).length,
    unplaced: Array.isArray(report.unplaced) ? report.unplaced.length : 0,
    errors: Array.isArray(report.errors) ? report.errors.length : 0,
    costUsd: typeof report.costUsd === 'number' ? report.costUsd : 0,
    error: row.error,
  };
}

async function requireRole(db: Database, userId: string, workspaceId: string) {
  return asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    return role;
  });
}

export async function generationStatus(db: Database, userId: string, workspaceId: string, now: Date): Promise<GenerationStatus> {
  const role = await requireRole(db, userId, workspaceId);
  return asUser(db, userId, async (trx) => {
    const ws = await trx.selectFrom('workspaces').select(['auto_generation', 'generation_cron', 'generation_requested_at']).where('id', '=', workspaceId).executeTakeFirstOrThrow();
    const runs = await trx
      .selectFrom('generation_runs')
      .select(['id', 'kind', 'status', 'started_at', 'finished_at', 'report', 'error'])
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'weekly')
      .orderBy('started_at', 'desc')
      .limit(10)
      .execute();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const usage = await trx
      .selectFrom('ai_usage')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<string>('cost_usd'), eb.val('0')).as('usd'),
        eb.fn.coalesce(eb.fn.sum<string>('cost_eur'), eb.val('0')).as('eur'),
        eb.fn.countAll<string>().filterWhere('counted_in_quota', '=', true).as('posts'),
      ])
      .where('workspace_id', '=', workspaceId)
      .where('at', '>=', monthStart)
      .executeTakeFirstOrThrow();
    return {
      canLaunch: canManageContent(role),
      canConfigure: role === 'owner' || role === 'admin',
      autoGeneration: ws.auto_generation,
      cron: ws.generation_cron,
      requestedAt: ws.generation_requested_at,
      running: runs.some((r) => r.status === 'running'),
      runs: runs.map(summarize),
      month: { costUsd: Number(usage.usd), costEur: Number(usage.eur), countedPosts: Number(usage.posts) },
    };
  });
}

/** GEN-01, REC-04 : « Lancer la rédaction » ; la tâche de fond la prend dans les 5 minutes. */
export async function requestGeneration(db: Database, userId: string, workspaceId: string, now: Date): Promise<void> {
  const role = await requireRole(db, userId, workspaceId);
  if (!canManageContent(role)) throw new ForbiddenError('launchGeneration');
  await asUser(db, userId, async (trx) => {
    await trx.updateTable('workspaces').set({ generation_requested_at: now }).where('id', '=', workspaceId).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'redaction.demandee', entity: 'workspace', entityId: workspaceId, details: {}, at: now });
  });
}

/** Rédaction automatique et son échéance (propriétaire et administrateurs). */
export async function configureGeneration(db: Database, userId: string, workspaceId: string, settings: { auto: boolean; cron: string }, now: Date): Promise<void> {
  const role = await requireRole(db, userId, workspaceId);
  if (role !== 'owner' && role !== 'admin') throw new ForbiddenError('configureGeneration');
  const cron = settings.cron.trim().replace(/\s+/g, ' ');
  if (parseCron(cron) === null) throw new RefusedError('cron_invalide', 'Programmation invalide.');
  await asUser(db, userId, async (trx) => {
    await trx.updateTable('workspaces').set({ auto_generation: settings.auto, generation_cron: cron }).where('id', '=', workspaceId).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'redaction.programmee', entity: 'workspace', entityId: workspaceId, details: { auto: settings.auto, cron }, at: now });
  });
}

export interface RunDetail extends RunSummary {
  readonly weeks: readonly string[];
  readonly model: string | null;
  readonly promptVersion: string | null;
  /** Rapport tel qu'enregistré par la tâche de fond (forme RunReport du paquet worker). */
  readonly report: Record<string, unknown>;
}

export async function getGenerationRun(db: Database, userId: string, workspaceId: string, runId: string): Promise<RunDetail> {
  await requireRole(db, userId, workspaceId);
  return asUser(db, userId, async (trx) => {
    const row = await trx
      .selectFrom('generation_runs')
      .select(['id', 'kind', 'status', 'started_at', 'finished_at', 'report', 'error', 'weeks', 'model', 'prompt_version'])
      .where('id', '=', runId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Rédaction');
    return { ...summarize(row), weeks: row.weeks, model: row.model, promptVersion: row.prompt_version, report: (row.report ?? {}) as Record<string, unknown> };
  });
}

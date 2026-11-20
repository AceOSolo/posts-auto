/**
 * ADM-03 : supervision. Files de rédaction, de demandes, de visuels et de publication ;
 * erreurs LinkedIn par type ; connexions expirées ; coûts de l'IA par fournisseur.
 */
import { DEFAULT_WORKSPACE_CALENDAR, startOfLocalMonth } from '@posts-auto/core';
import { type Database, asSystem } from '@posts-auto/db';
import { sql } from 'kysely';
import { requirePlatformAdmin } from './platform.ts';

export interface Supervision {
  readonly generation: { readonly running: number; readonly oldestRunningAt: Date | null; readonly doneLast24h: number; readonly failedLast7d: number };
  readonly recentFailures: readonly { readonly at: Date; readonly orgName: string; readonly workspaceName: string; readonly what: string; readonly error: string }[];
  readonly requests: { readonly waiting: number; readonly oldestAt: Date | null };
  readonly visuals: { readonly waiting: number; readonly failed: number };
  readonly publication: { readonly late: number; readonly publishing: number; readonly inError: number; readonly publishedLast24h: number };
  readonly linkedinErrors: readonly { readonly code: string; readonly count: number; readonly lastAt: Date }[];
  readonly accounts: { readonly expiring: number; readonly expired: number; readonly revoked: number; readonly paused: number };
  readonly expiredAccounts: readonly { readonly orgName: string; readonly workspaceName: string; readonly accountName: string; readonly status: string; readonly since: Date }[];
  readonly aiCosts: readonly { readonly provider: string; readonly kind: string; readonly calls: number; readonly units: number; readonly costEurThisMonth: number; readonly costEurLastMonth: number }[];
}

export async function supervision(db: Database, adminId: string, now: Date): Promise<Supervision> {
  await requirePlatformAdmin(db, adminId);
  const day = new Date(now.getTime() - 86_400_000);
  const week = new Date(now.getTime() - 7 * 86_400_000);
  const monthStart = startOfLocalMonth(now, DEFAULT_WORKSPACE_CALENDAR);
  const lastMonthStart = startOfLocalMonth(new Date(monthStart.getTime() - 86_400_000), DEFAULT_WORKSPACE_CALENDAR);
  return asSystem(db, async (trx) => {
    const gen = await trx
      .selectFrom('generation_runs')
      .select([
        sql<number>`(count(*) filter (where status = 'running'))::int`.as('running'),
        sql<Date | null>`min(started_at) filter (where status = 'running')`.as('oldest'),
        sql<number>`(count(*) filter (where status = 'done' and finished_at >= ${day}))::int`.as('done'),
        sql<number>`(count(*) filter (where status = 'failed' and started_at >= ${week}))::int`.as('failed'),
      ])
      .executeTakeFirstOrThrow();
    const failedRuns = await trx
      .selectFrom('generation_runs as r')
      .innerJoin('workspaces as w', 'w.id', 'r.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .select(['r.started_at as at', 'o.name as org', 'w.name as ws', 'r.kind', 'r.error'])
      .where('r.status', '=', 'failed')
      .where('r.started_at', '>=', week)
      .orderBy('r.started_at', 'desc')
      .limit(10)
      .execute();
    const failedVisuals = await trx
      .selectFrom('visual_tasks as v')
      .innerJoin('workspaces as w', 'w.id', 'v.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .select(['v.failed_at as at', 'o.name as org', 'w.name as ws', 'v.error'])
      .where('v.failed_at', '>=', week)
      .orderBy('v.failed_at', 'desc')
      .limit(10)
      .execute();
    const requests = await trx
      .selectFrom('post_requests')
      .select([sql<number>`count(*)::int`.as('n'), sql<Date | null>`min(created_at)`.as('oldest')])
      .where('status', 'in', ['new', 'in_progress'])
      .executeTakeFirstOrThrow();
    const visuals = await trx
      .selectFrom('visual_tasks')
      .select([sql<number>`(count(*) filter (where failed_at is null))::int`.as('waiting'), sql<number>`(count(*) filter (where failed_at is not null))::int`.as('failed')])
      .executeTakeFirstOrThrow();
    const pub = await trx
      .selectFrom('posts')
      .select([
        sql<number>`(count(*) filter (where status = 'valide' and scheduled_at < ${new Date(now.getTime() - 10 * 60_000)}))::int`.as('late'),
        sql<number>`(count(*) filter (where status = 'en_publication'))::int`.as('publishing'),
        sql<number>`(count(*) filter (where status = 'erreur'))::int`.as('error'),
        sql<number>`(count(*) filter (where status = 'publie' and published_at >= ${day}))::int`.as('published'),
      ])
      .executeTakeFirstOrThrow();
    const errors = await trx
      .selectFrom('publish_attempts')
      .select([sql<string>`coalesce(error_code, 'http_' || coalesce(http_status::text, 'inconnu'))`.as('code'), sql<number>`count(*)::int`.as('n'), sql<Date>`max(started_at)`.as('last')])
      .where('started_at', '>=', week)
      .where((eb) => eb.or([eb('error_code', 'is not', null), eb('outcome', '<>', 'published')]))
      .groupBy(sql`1`)
      .orderBy(sql`2`, 'desc')
      .execute();
    const accounts = await trx
      .selectFrom('social_accounts')
      .select([
        sql<number>`(count(*) filter (where status = 'expiring'))::int`.as('expiring'),
        sql<number>`(count(*) filter (where status = 'expired'))::int`.as('expired'),
        sql<number>`(count(*) filter (where status = 'revoked'))::int`.as('revoked'),
        sql<number>`(count(*) filter (where status = 'paused'))::int`.as('paused'),
      ])
      .executeTakeFirstOrThrow();
    const expired = await trx
      .selectFrom('social_accounts as a')
      .innerJoin('workspaces as w', 'w.id', 'a.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .select(['o.name as org', 'w.name as ws', 'a.display_name', 'a.status', 'a.updated_at'])
      .where('a.status', 'in', ['expiring', 'expired'])
      .orderBy('a.updated_at')
      .limit(30)
      .execute();
    const costs = await trx
      .selectFrom('ai_usage')
      .select([
        'provider',
        'kind',
        sql<number>`(count(*) filter (where at >= ${monthStart}))::int`.as('calls'),
        sql<number>`(coalesce(sum(units) filter (where at >= ${monthStart}), 0))::int`.as('units'),
        sql<number>`(coalesce(sum(cost_eur) filter (where at >= ${monthStart}), 0))::float8`.as('this_month'),
        sql<number>`(coalesce(sum(cost_eur) filter (where at >= ${lastMonthStart} and at < ${monthStart}), 0))::float8`.as('last_month'),
      ])
      .where('at', '>=', lastMonthStart)
      .groupBy(['provider', 'kind'])
      .orderBy('provider')
      .orderBy('kind')
      .execute();
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      generation: { running: gen.running, oldestRunningAt: gen.oldest, doneLast24h: gen.done, failedLast7d: gen.failed },
      recentFailures: [
        ...failedRuns.map((r) => ({ at: r.at, orgName: r.org, workspaceName: r.ws, what: `rédaction (${r.kind})`, error: r.error ?? '' })),
        ...failedVisuals.map((v) => ({ at: v.at as Date, orgName: v.org, workspaceName: v.ws, what: 'visuel', error: v.error ?? '' })),
      ]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, 15),
      requests: { waiting: requests.n, oldestAt: requests.oldest },
      visuals: { waiting: visuals.waiting, failed: visuals.failed },
      publication: { late: pub.late, publishing: pub.publishing, inError: pub.error, publishedLast24h: pub.published },
      linkedinErrors: errors.map((e) => ({ code: e.code, count: e.n, lastAt: e.last })),
      accounts,
      expiredAccounts: expired.map((a) => ({ orgName: a.org, workspaceName: a.ws, accountName: a.display_name ?? 'Compte', status: a.status, since: a.updated_at })),
      aiCosts: costs.map((c) => ({ provider: c.provider, kind: c.kind, calls: c.calls, units: c.units, costEurThisMonth: round(c.this_month), costEurLastMonth: round(c.last_month) })),
    };
  });
}

/** ADM-04 : modèles d'IA et versions de consignes réellement utilisés, sur 30 jours. */
export async function aiModelsInUse(db: Database, adminId: string, now: Date) {
  await requirePlatformAdmin(db, adminId);
  const since = new Date(now.getTime() - 30 * 86_400_000);
  return asSystem(db, async (trx) => {
    const models = await trx
      .selectFrom('ai_usage')
      .select(['provider', 'model', 'purpose', sql<number>`count(*)::int`.as('calls'), sql<number>`coalesce(sum(cost_eur), 0)::float8`.as('cost')])
      .where('at', '>=', since)
      .groupBy(['provider', 'model', 'purpose'])
      .orderBy('provider')
      .orderBy('model')
      .orderBy('purpose')
      .execute();
    const prompts = await trx
      .selectFrom('generation_runs')
      .select([sql<string>`coalesce(prompt_version, '—')`.as('version'), sql<string>`coalesce(model, '—')`.as('model'), sql<number>`count(*)::int`.as('runs'), sql<Date>`max(started_at)`.as('last')])
      .where('started_at', '>=', since)
      .groupBy([sql`1`, sql`2`])
      .orderBy(sql`4`, 'desc')
      .execute();
    return {
      models: models.map((m) => ({ provider: m.provider, model: m.model, purpose: m.purpose, calls: m.calls, costEur: Math.round(m.cost * 100) / 100 })),
      prompts: prompts.map((p) => ({ version: p.version, model: p.model, runs: p.runs, lastAt: p.last })),
    };
  });
}

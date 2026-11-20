/**
 * Tableau de bord de l'espace (SUI-01), indicateurs par compte et par semaine (SUI-02),
 * export CSV de tous les posts (SUI-06). Lu sous l'identité de la personne (RLS) : tous les
 * membres de l'espace le voient.
 *
 * Seules des données produites par l'outil : aucune statistique LinkedIn de profil (L7).
 */
import { POST_STATUSES, type PostStatus } from '@posts-auto/core';
import { type Database, asUser } from '@posts-auto/db';
import { type AccountSummary, listWorkspaceAccounts } from '../accounts/accounts.ts';
import { workspaceRole } from '../access.ts';
import { NotFoundError } from '../errors.ts';
import { currentWeekOf } from '../planning/planning.ts';
import { type AccountTracking, weekDocument } from '../planning/week-document.ts';

export interface DashboardPost {
  readonly postId: string;
  readonly accountName: string;
  readonly scheduledAt: Date;
  readonly status: PostStatus;
  readonly lastError: string | null;
}

export interface Dashboard {
  readonly workspaceName: string;
  readonly timeZone: string;
  readonly weekStart: string;
  /** Posts de la semaine en cours, par statut (hors posts remplacés). */
  readonly byStatus: Readonly<Partial<Record<PostStatus, number>>>;
  /** Posts « à valider » par personne qui doit valider (titulaire, ou compte sans titulaire). */
  readonly pendingByHolder: readonly { readonly holder: string; readonly count: number; readonly nextAt: Date }[];
  /** Prochains départs validés (7 jours). */
  readonly nextDepartures: readonly DashboardPost[];
  readonly errors: readonly DashboardPost[];
  /** Comptes dont la connexion expire bientôt ou a expiré. */
  readonly accountsToReconnect: readonly AccountSummary[];
  /** SUI-02 : 8 dernières semaines, par compte. */
  readonly tracking: readonly AccountTracking[];
}

export async function workspaceDashboard(db: Database, userId: string, workspaceId: string, now: Date): Promise<Dashboard> {
  const base = await asUser(db, userId, async (trx) => {
    if ((await workspaceRole(trx, userId, workspaceId)) === null) throw new NotFoundError('Espace');
    const workspace = await trx.selectFrom('workspaces').select(['name', 'timezone']).where('id', '=', workspaceId).executeTakeFirstOrThrow();
    const week = await currentWeekOf(trx, workspaceId, now);
    const weekPosts = await trx.selectFrom('posts').select('status').where('workspace_id', '=', workspaceId).where('week_start', '=', week).where('status', '<>', 'remplace').execute();
    const byStatus: Partial<Record<PostStatus, number>> = {};
    for (const p of weekPosts) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

    const select = trx
      .selectFrom('posts as p')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .leftJoin('users as u', 'u.id', 'a.holder_user_id')
      .select(['p.id', 'a.display_name', 'a.kind', 'u.full_name', 'u.email', 'p.scheduled_at', 'p.status', 'p.last_error'])
      .where('p.workspace_id', '=', workspaceId);
    const pending = await select.where('p.status', '=', 'a_valider').orderBy('p.scheduled_at').execute();
    const next = await select
      .where('p.status', 'in', ['valide', 'en_publication'])
      .where('p.scheduled_at', '<=', new Date(now.getTime() + 7 * 86_400_000))
      .orderBy('p.scheduled_at')
      .limit(10)
      .execute();
    const errors = await select.where('p.status', '=', 'erreur').orderBy('p.scheduled_at').execute();

    const groups = new Map<string, { holder: string; count: number; nextAt: Date }>();
    for (const p of pending) {
      const holder = p.full_name ?? p.email ?? `${p.display_name ?? 'Compte'} (${p.kind === 'page' ? 'page, validateurs délégués' : 'sans titulaire'})`;
      const group = groups.get(holder) ?? { holder, count: 0, nextAt: p.scheduled_at };
      group.count += 1;
      if (p.scheduled_at < group.nextAt) group.nextAt = p.scheduled_at;
      groups.set(holder, group);
    }
    const toPost = (p: (typeof pending)[number]): DashboardPost => ({ postId: p.id, accountName: p.display_name ?? 'Compte', scheduledAt: p.scheduled_at, status: p.status, lastError: p.last_error });
    return {
      workspaceName: workspace.name,
      timeZone: workspace.timezone,
      weekStart: week,
      byStatus,
      pendingByHolder: [...groups.values()].sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime()),
      nextDepartures: next.map(toPost),
      errors: errors.map(toPost),
    };
  });
  const accounts = await listWorkspaceAccounts(db, userId, workspaceId);
  const { tracking } = await weekDocument(db, userId, workspaceId, base.weekStart, now);
  return { ...base, accountsToReconnect: accounts.filter((a) => a.status === 'expiring' || a.status === 'expired'), tracking };
}

/** SUI-06 : une ligne par post (hors posts remplacés par leur reprise). */
export interface PostExportRow {
  readonly scheduledAt: Date;
  readonly accountName: string;
  readonly accountKind: 'profile' | 'page';
  readonly status: PostStatus;
  readonly origin: string;
  readonly subject: string | null;
  readonly body: string;
  readonly images: number;
  readonly aiImage: boolean;
  readonly versionNo: number;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly publishedAt: Date | null;
  readonly url: string | null;
}

export const EXPORT_MAX_ROWS = 10_000;

export async function exportPosts(db: Database, userId: string, workspaceId: string): Promise<{ workspaceName: string; timeZone: string; rows: PostExportRow[] }> {
  return asUser(db, userId, async (trx) => {
    if ((await workspaceRole(trx, userId, workspaceId)) === null) throw new NotFoundError('Espace');
    const workspace = await trx.selectFrom('workspaces').select(['name', 'timezone']).where('id', '=', workspaceId).executeTakeFirstOrThrow();
    const rows = await trx
      .selectFrom('posts as p')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .leftJoin('users as d', 'd.id', 'p.decided_by')
      .select((eb) => [
        'p.scheduled_at',
        'a.display_name',
        'a.kind',
        'p.status',
        'p.origin',
        'p.source_note',
        'v.body',
        'p.version_no',
        'p.decided_at',
        'd.full_name as decided_by',
        'p.published_at',
        'p.external_post_url',
        eb.selectFrom('post_media as pm').select(eb.fn.countAll<string>().as('n')).whereRef('pm.post_id', '=', 'p.id').as('images'),
        eb
          .exists(eb.selectFrom('post_media as pm').innerJoin('media_assets as m', 'm.id', 'pm.asset_id').select('pm.id').whereRef('pm.post_id', '=', 'p.id').where('m.ai_generated', '=', true))
          .as('ai_image'),
      ])
      .where('p.workspace_id', '=', workspaceId)
      .where('p.status', '<>', 'remplace')
      .orderBy('p.scheduled_at')
      .limit(EXPORT_MAX_ROWS)
      .execute();
    return {
      workspaceName: workspace.name,
      timeZone: workspace.timezone,
      rows: rows.map((r) => ({
        scheduledAt: r.scheduled_at,
        accountName: r.display_name ?? 'Compte',
        accountKind: r.kind as 'profile' | 'page',
        status: r.status,
        origin: r.origin,
        subject: r.source_note,
        body: r.body ?? '',
        images: Number(r.images ?? 0),
        aiImage: Boolean(r.ai_image),
        versionNo: r.version_no,
        decidedAt: r.decided_at,
        decidedBy: r.decided_by,
        publishedAt: r.published_at,
        url: r.external_post_url,
      })),
    };
  });
}

export const STATUS_ORDER: readonly PostStatus[] = POST_STATUSES;

/**
 * Document de semaine (GEN-10) : planning et inventaire de la semaine, posts de la semaine,
 * et suivi des 8 dernières semaines par compte (indicateurs de la section 2.3 : part validée
 * telle quelle, modifiée, refusée, délai de validation, créneaux tenus). Page imprimable.
 *
 * Seules des données produites par l'outil : aucune statistique LinkedIn de profil (L7).
 */
import type { PostStatus } from '@posts-auto/core';
import { addDays, isoWeekNumber } from '@posts-auto/core';
import { type Database, asUser } from '@posts-auto/db';
import { workspaceRole } from '../access.ts';
import { NotFoundError } from '../errors.ts';
import { currentWeekOf, isMonday } from './planning.ts';

export interface WeekPost {
  readonly id: string;
  readonly accountName: string;
  readonly scheduledAt: Date;
  readonly status: PostStatus;
  readonly origin: string;
  readonly subject: string | null;
  readonly body: string;
}

export interface WeekStats {
  readonly weekStart: string;
  readonly isoWeek: number;
  /** Posts proposés (hors remplacés). */
  readonly proposed: number;
  readonly published: number;
  /** Validés sans aucune correction du texte par une personne. */
  readonly validatedAsIs: number;
  /** Validés après correction, ou après une demande de modification. */
  readonly validatedModified: number;
  readonly refused: number;
  /** Délai médian entre la proposition et la décision, en heures. */
  readonly medianDecisionHours: number | null;
  /** Publiés à leur créneau d'origine (sans replanification). */
  readonly onTime: number;
}

export interface AccountTracking {
  readonly accountId: string;
  readonly accountName: string;
  readonly weeks: readonly WeekStats[];
}

export interface WeekDocument {
  readonly workspaceName: string;
  readonly weekStart: string;
  readonly isoWeek: number;
  readonly posts: readonly WeekPost[];
  readonly tracking: readonly AccountTracking[];
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export async function weekDocument(db: Database, userId: string, workspaceId: string, weekStart: string | undefined, now: Date): Promise<WeekDocument> {
  return asUser(db, userId, async (trx) => {
    if ((await workspaceRole(trx, userId, workspaceId)) === null) throw new NotFoundError('Espace');
    const week = weekStart !== undefined && isMonday(weekStart) ? weekStart : await currentWeekOf(trx, workspaceId, now);
    const workspace = await trx.selectFrom('workspaces').select('name').where('id', '=', workspaceId).executeTakeFirstOrThrow();

    const posts = await trx
      .selectFrom('posts as p')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.id', 'a.display_name', 'p.scheduled_at', 'p.status', 'p.origin', 'p.source_note', 'v.body'])
      .where('p.workspace_id', '=', workspaceId)
      .where('p.week_start', '=', week)
      .where('p.status', 'not in', ['remplace'])
      .orderBy('p.scheduled_at')
      .execute();

    // Suivi des 8 semaines qui précèdent et incluent la semaine du document.
    const weeks = Array.from({ length: 8 }, (_, i) => addDays(week, -7 * (7 - i)));
    const rows = await trx
      .selectFrom('posts as p')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .select((eb) => [
        'p.account_id',
        'a.display_name',
        'p.week_start',
        'p.status',
        'p.created_at',
        'p.decided_at',
        'p.reschedule_count',
        'p.published_at',
        'p.original_scheduled_at',
        eb.exists(eb.selectFrom('post_versions as v').select('v.id').whereRef('v.post_id', '=', 'p.id').where('v.author_kind', '=', 'user')).as('edited'),
        eb
          .exists(eb.selectFrom('post_status_history as h').select('h.id').whereRef('h.post_id', '=', 'p.id').where('h.to_status', '=', 'modif'))
          .as('changes_requested'),
        eb.exists(eb.selectFrom('post_status_history as h').select('h.id').whereRef('h.post_id', '=', 'p.id').where('h.to_status', '=', 'refuse')).as('refused'),
      ])
      .where('p.workspace_id', '=', workspaceId)
      .where('p.week_start', 'in', weeks)
      .execute();

    const accounts = new Map<string, string>();
    for (const r of rows) accounts.set(r.account_id, r.display_name ?? 'Compte');
    const tracking: AccountTracking[] = [...accounts.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], 'fr'))
      .map(([accountId, accountName]) => ({
        accountId,
        accountName,
        weeks: weeks.map((w) => {
          const list = rows.filter((r) => r.account_id === accountId && r.week_start === w);
          const live = list.filter((r) => r.status !== 'remplace');
          const decided = live.filter((r) => ['valide', 'en_publication', 'publie'].includes(r.status));
          return {
            weekStart: w,
            isoWeek: isoWeekNumber(w),
            proposed: live.length,
            published: live.filter((r) => r.status === 'publie').length,
            validatedAsIs: decided.filter((r) => !r.edited && !r.changes_requested).length,
            validatedModified: decided.filter((r) => Boolean(r.edited) || Boolean(r.changes_requested)).length,
            // Un post refusé est ensuite remplacé par sa reprise : il compte ici même remplacé.
            refused: list.filter((r) => Boolean(r.refused)).length,
            medianDecisionHours: median(
              decided.filter((r) => r.decided_at !== null).map((r) => Math.round(((r.decided_at as Date).getTime() - r.created_at.getTime()) / 360_000) / 10),
            ),
            onTime: live.filter((r) => r.status === 'publie' && r.reschedule_count === 0).length,
          };
        }),
      }));

    return {
      workspaceName: workspace.name,
      weekStart: week,
      isoWeek: isoWeekNumber(week),
      posts: posts.map((p) => ({ id: p.id, accountName: p.display_name ?? 'Compte', scheduledAt: p.scheduled_at, status: p.status, origin: p.origin, subject: p.source_note, body: p.body ?? '' })),
      tracking,
    };
  });
}

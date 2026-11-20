/**
 * Meilleurs moments pour publier, par compte : à partir des statistiques LinkedIn relevées à
 * J+7 sur les posts publiés des six derniers mois, classe les moments de la semaine (jour et
 * tranche horaire, heure de l'espace) et propose un créneau habituel quand l'un d'eux se
 * détache nettement. Rien n'est proposé sans assez de posts mesurés : pas de conseil inventé.
 */
import type { IsoWeekday, UsualSlot } from '@posts-auto/core';
import { type Database, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { NotFoundError } from '../errors.ts';

export const TIME_BANDS = {
  matin: { label: 'le matin (7 h – 11 h)', from: 7, to: 11 },
  midi: { label: 'le midi (11 h – 14 h)', from: 11, to: 14 },
  'apres-midi': { label: 'l’après-midi (14 h – 17 h)', from: 14, to: 17 },
  'fin-de-journee': { label: 'en fin de journée (17 h – 20 h)', from: 17, to: 20 },
  soir: { label: 'le soir ou la nuit (20 h – 7 h)', from: 20, to: 7 },
} as const;
export type TimeBand = keyof typeof TIME_BANDS;

export const WEEKDAY_NAMES = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'] as const;

/** Posts mesurés nécessaires avant de conseiller, et posts par moment pour le classer. */
export const MIN_MEASURED = 6;
export const MIN_PER_GROUP = 2;
/** Écart minimal avec la moyenne pour proposer un moment. */
const MIN_GAIN = 0.2;
const LOOKBACK_DAYS = 183;

export interface MeasuredPost {
  readonly publishedAt: Date;
  readonly impressions: number | null;
  readonly reactions: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
}

export interface PostingTimeGroup {
  readonly weekday: IsoWeekday;
  readonly band: TimeBand;
  readonly posts: number;
  /** Interactions pour 1 000 impressions, ou interactions moyennes sans impressions. */
  readonly score: number;
  readonly averageImpressions: number | null;
  /** Heure de publication la plus fréquente de ce moment (HH:MM), pour un créneau habituel. */
  readonly suggestedTime: string;
}

export interface PostingTimesAdvice {
  readonly measured: number;
  readonly needed: number;
  /** « taux » : interactions pour 1 000 impressions ; « interactions » : LinkedIn ne donne pas les impressions. */
  readonly metric: 'taux' | 'interactions';
  readonly groups: readonly PostingTimeGroup[];
  readonly best: PostingTimeGroup | null;
  /** Écart du meilleur moment avec la moyenne de tous les posts mesurés, en pour cent. */
  readonly gainPercent: number | null;
  /** Le meilleur moment correspond déjà à un créneau habituel du compte. */
  readonly alreadyUsed: boolean;
}

const interactions = (p: MeasuredPost) => (p.reactions ?? 0) + 2 * (p.comments ?? 0) + 3 * (p.shares ?? 0);

export function bandOf(hour: number): TimeBand {
  for (const [band, range] of Object.entries(TIME_BANDS) as [TimeBand, (typeof TIME_BANDS)[TimeBand]][]) {
    if (range.from < range.to && hour >= range.from && hour < range.to) return band;
  }
  return 'soir';
}

const WEEKDAY_INDEX: Record<string, IsoWeekday> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Jour ISO et heure locale (HH:MM, arrondie à 5 minutes) d'un instant dans un fuseau. */
export function localSlot(at: Date, timeZone: string): { weekday: IsoWeekday; hour: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Math.floor(Number(get('minute')) / 5) * 5;
  return { weekday: WEEKDAY_INDEX[get('weekday')] ?? 1, hour, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function mostFrequent(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '12:00';
}

export function advisePostingTimes(posts: readonly MeasuredPost[], timeZone: string, usualSlots: readonly UsualSlot[]): PostingTimesAdvice {
  const measured = posts.filter((p) => p.reactions !== null || p.comments !== null || p.shares !== null);
  const metric = measured.length > 0 && measured.every((p) => (p.impressions ?? 0) > 0) ? 'taux' : 'interactions';
  const score = (rows: readonly MeasuredPost[]) =>
    metric === 'taux'
      ? (1000 * rows.reduce((s, p) => s + interactions(p), 0)) / Math.max(1, rows.reduce((s, p) => s + (p.impressions ?? 0), 0))
      : rows.reduce((s, p) => s + interactions(p), 0) / Math.max(1, rows.length);
  const empty: PostingTimesAdvice = { measured: measured.length, needed: MIN_MEASURED, metric, groups: [], best: null, gainPercent: null, alreadyUsed: false };
  if (measured.length < MIN_MEASURED) return empty;

  const byMoment = new Map<string, { weekday: IsoWeekday; band: TimeBand; rows: MeasuredPost[]; times: string[] }>();
  for (const p of measured) {
    const local = localSlot(p.publishedAt, timeZone);
    const band = bandOf(local.hour);
    const key = `${local.weekday}-${band}`;
    const group = byMoment.get(key) ?? { weekday: local.weekday, band, rows: [], times: [] };
    group.rows.push(p);
    group.times.push(local.time);
    byMoment.set(key, group);
  }
  const groups: PostingTimeGroup[] = [...byMoment.values()]
    .filter((g) => g.rows.length >= MIN_PER_GROUP)
    .map((g) => {
      const withImpressions = g.rows.filter((p) => p.impressions !== null);
      return {
        weekday: g.weekday,
        band: g.band,
        posts: g.rows.length,
        score: Math.round(score(g.rows) * 10) / 10,
        averageImpressions: withImpressions.length === 0 ? null : Math.round(withImpressions.reduce((s, p) => s + (p.impressions ?? 0), 0) / withImpressions.length),
        suggestedTime: mostFrequent(g.times),
      };
    })
    .sort((a, b) => b.score - a.score || b.posts - a.posts);

  const overall = score(measured);
  const top = groups[0];
  // Un seul moment mesuré ne se compare à rien : pas de conseil.
  if (top === undefined || groups.length < 2 || overall <= 0) return { ...empty, groups };
  const gain = top.score / overall - 1;
  if (gain < MIN_GAIN) return { ...empty, groups };
  const alreadyUsed = usualSlots.some((s) => s.weekday === top.weekday && bandOf(Number(s.time.slice(0, 2))) === top.band);
  return { ...empty, groups, best: top, gainPercent: Math.round(gain * 100), alreadyUsed };
}

/** Conseil pour un compte, lu sous l'identité de la personne (membre de l'espace). */
export async function postingTimesAdvice(db: Database, userId: string, accountId: string, now: Date, usualSlots: readonly UsualSlot[]): Promise<PostingTimesAdvice> {
  return asUser(db, userId, async (trx) => {
    const account = await trx
      .selectFrom('social_accounts as a')
      .innerJoin('workspaces as w', 'w.id', 'a.workspace_id')
      .select(['a.id', 'w.timezone'])
      .where('a.id', '=', accountId)
      .executeTakeFirst();
    if (account === undefined) throw new NotFoundError('Compte');
    const rows = await trx
      .selectFrom('posts as p')
      .select([
        'p.published_at',
        sql<Record<string, number | null> | null>`(select to_jsonb(s) from post_stats s where s.post_id = p.id and s.available and s.day_offset in (7, 30) order by s.day_offset limit 1)`.as('stats'),
      ])
      .where('p.account_id', '=', accountId)
      .where('p.status', '=', 'publie')
      .where('p.published_at', '>=', new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000))
      .execute();
    const posts: MeasuredPost[] = rows
      .filter((r) => r.published_at !== null && r.stats !== null)
      .map((r) => ({
        publishedAt: r.published_at as Date,
        impressions: r.stats?.['impressions'] ?? null,
        reactions: r.stats?.['reactions'] ?? null,
        comments: r.stats?.['comments'] ?? null,
        shares: r.stats?.['shares'] ?? null,
      }));
    return advisePostingTimes(posts, account.timezone, usualSlots);
  });
}

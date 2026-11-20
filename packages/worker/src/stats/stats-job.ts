/**
 * SUI-03 : relevé des statistiques LinkedIn des posts publiés, à J+1, J+7 et J+30 (avec
 * 5 jours de rattrapage si le relevé n'a pas pu se faire), et des abonnés des pages, une
 * fois par jour. Toutes les 6 heures. Un compte sans connexion valable est sauté ; une
 * statistique que LinkedIn ne donne pas est notée « indisponible ».
 */
import { type Database, asSystem } from '@posts-auto/db';
import { LinkedInError, type LinkedInStats } from '@posts-auto/linkedin';
import { sql } from 'kysely';
import type { TokenCipher } from '../secrets/token-cipher.ts';

export const STAT_OFFSETS = [1, 7, 30] as const;
const CATCH_UP_DAYS = 5;
const BATCH = 200;

export interface StatsDeps {
  readonly db: Database;
  readonly stats: LinkedInStats;
  readonly cipher: TokenCipher;
  readonly clock?: () => Date;
}

export interface StatsReport {
  readonly captured: number;
  readonly unavailable: number;
  readonly followers: number;
  readonly errors: number;
}

function tokenOf(cipher: TokenCipher, row: { access_token_enc: Uint8Array | null; account_id: string }): string | null {
  if (row.access_token_enc === null) return null;
  try {
    return cipher.decrypt(row.access_token_enc, row.account_id);
  } catch {
    return null;
  }
}

export async function runStatsTick(deps: StatsDeps): Promise<StatsReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const report = { captured: 0, unavailable: 0, followers: 0, errors: 0 };

  for (const offset of STAT_OFFSETS) {
    const due = await asSystem(deps.db, (trx) =>
      trx
        .selectFrom('posts as p')
        .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
        .leftJoin('social_tokens as t', 't.account_id', 'a.id')
        .select(['p.id', 'p.workspace_id', 'p.external_post_urn', 'a.id as account_id', 'a.external_urn', 'a.status', 't.access_token_enc', 't.expires_at'])
        .where('p.status', '=', 'publie')
        .where('p.external_post_urn', 'is not', null)
        .where('p.published_at', '<=', new Date(now.getTime() - offset * 86_400_000))
        .where('p.published_at', '>', new Date(now.getTime() - (offset + CATCH_UP_DAYS) * 86_400_000))
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('post_stats as s').select('s.post_id').whereRef('s.post_id', '=', 'p.id').where('s.day_offset', '=', offset))))
        .limit(BATCH)
        .execute(),
    );
    for (const post of due) {
      const token = post.status === 'connected' || post.status === 'expiring' ? tokenOf(deps.cipher, post) : null;
      if (token === null || (post.expires_at !== null && post.expires_at.getTime() <= now.getTime())) continue;
      try {
        const stats = await deps.stats.postStats({ accessToken: token, postUrn: post.external_post_urn as string, authorUrn: post.external_urn });
        await asSystem(deps.db, (trx) =>
          trx
            .insertInto('post_stats')
            .values({
              post_id: post.id,
              workspace_id: post.workspace_id,
              day_offset: offset,
              captured_at: now,
              available: stats !== null,
              impressions: stats?.impressions ?? null,
              reactions: stats?.reactions ?? null,
              comments: stats?.comments ?? null,
              shares: stats?.shares ?? null,
            })
            .onConflict((oc) => oc.columns(['post_id', 'day_offset']).doNothing())
            .execute(),
        );
        if (stats === null) report.unavailable += 1;
        else report.captured += 1;
      } catch (error) {
        // Réseau ou LinkedIn indisponible : nouvel essai au passage suivant.
        if (!(error instanceof LinkedInError)) throw error;
        report.errors += 1;
      }
    }
  }

  // Abonnés des pages : un relevé par jour (date de Paris).
  const today = sql<string>`(now() at time zone 'Europe/Paris')::date`;
  const pages = await asSystem(deps.db, (trx) =>
    trx
      .selectFrom('social_accounts as a')
      .leftJoin('social_tokens as t', 't.account_id', 'a.id')
      .select(['a.id as account_id', 'a.workspace_id', 'a.external_urn', 't.access_token_enc'])
      .where('a.kind', '=', 'page')
      .where('a.status', 'in', ['connected', 'expiring'])
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('account_followers as f').select('f.account_id').whereRef('f.account_id', '=', 'a.id').where('f.captured_on', '=', today))))
      .execute(),
  );
  for (const page of pages) {
    const token = tokenOf(deps.cipher, page);
    if (token === null) continue;
    try {
      const followers = await deps.stats.followers({ accessToken: token, organizationUrn: page.external_urn });
      if (followers === null) continue;
      await asSystem(deps.db, (trx) =>
        trx
          .insertInto('account_followers')
          .values({ account_id: page.account_id, workspace_id: page.workspace_id, captured_on: today, followers })
          .onConflict((oc) => oc.columns(['account_id', 'captured_on']).doNothing())
          .execute(),
      );
      report.followers += 1;
    } catch (error) {
      if (!(error instanceof LinkedInError)) throw error;
      report.errors += 1;
    }
  }
  return report;
}

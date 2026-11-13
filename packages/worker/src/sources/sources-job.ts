/**
 * Relève des sources externes (GEN-09), toutes les heures : nouveaux articles des flux RSS
 * et Atom des espaces. Les articles alimentent la rédaction au rang 6 de GEN-02 (« autre
 * matière vérifiable ») ; un article ne sert qu'une fois.
 */
import { type Database, asSystem } from '@posts-auto/db';
import { type FeedFetcher, FeedError, fetchFeedText, parseFeed } from './fetch-feed.ts';

/** Une source n'est pas relevée plus d'une fois par heure. */
export const SOURCE_REFRESH_MINUTES = 55;
/** Articles plus anciens : ignorés. */
export const SOURCE_MAX_AGE_DAYS = 60;
const MAX_ITEMS_PER_FETCH = 50;

export interface SourcesDeps {
  readonly db: Database;
  readonly fetcher?: FeedFetcher;
  readonly clock?: () => Date;
}

export async function runSourcesTick(deps: SourcesDeps): Promise<{ fetched: string[]; failed: string[]; newItems: number }> {
  const now = (deps.clock ?? (() => new Date()))();
  const fetcher = deps.fetcher ?? fetchFeedText;
  const due = await asSystem(deps.db, (trx) =>
    trx
      .selectFrom('content_sources')
      .select(['id', 'workspace_id', 'url'])
      .where('enabled', '=', true)
      .where((eb) => eb.or([eb('last_fetched_at', 'is', null), eb('last_fetched_at', '<', new Date(now.getTime() - SOURCE_REFRESH_MINUTES * 60_000))]))
      .orderBy('last_fetched_at', 'asc')
      .limit(50)
      .execute(),
  );
  const report = { fetched: [] as string[], failed: [] as string[], newItems: 0 };
  const oldest = now.getTime() - SOURCE_MAX_AGE_DAYS * 86_400_000;
  for (const source of due) {
    try {
      const items = parseFeed(await fetcher(source.url));
      if (items === null) throw new FeedError('Ce document n’est pas un flux RSS ou Atom.');
      const recent = items
        .filter((item) => item.publishedAt === null || item.publishedAt.getTime() >= oldest)
        .slice(0, MAX_ITEMS_PER_FETCH);
      const inserted = await asSystem(deps.db, async (trx) => {
        let count = 0;
        for (const item of recent) {
          const row = await trx
            .insertInto('source_items')
            .values({ workspace_id: source.workspace_id, source_id: source.id, guid: item.guid, title: item.title, link: item.link, summary: item.summary, published_at: item.publishedAt, fetched_at: now })
            .onConflict((oc) => oc.columns(['source_id', 'guid']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (row !== undefined) count += 1;
        }
        await trx.updateTable('content_sources').set({ last_fetched_at: now, last_error: null }).where('id', '=', source.id).execute();
        return count;
      });
      report.newItems += inserted;
      report.fetched.push(source.id);
    } catch (error) {
      const message = error instanceof FeedError ? error.message : 'Erreur inattendue pendant la relève.';
      await asSystem(deps.db, (trx) => trx.updateTable('content_sources').set({ last_fetched_at: now, last_error: message }).where('id', '=', source.id).execute());
      report.failed.push(source.id);
    }
  }
  return report;
}

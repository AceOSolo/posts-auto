/**
 * Lecture d'un flux RSS ou Atom (GEN-09), adresse saisie par un client.
 *
 * Le téléchargement passe par safeFetchText (@posts-auto/services) : protection contre
 * l'accès au réseau interne (SSRF), ports 80 et 443, 2 Mo et 10 secondes au plus,
 * 3 redirections au plus.
 */
import { SAFE_FETCH_MAX_BYTES, SAFE_FETCH_TIMEOUT_MS, SafeFetchError, isForbiddenAddress, plainText, safeFetchText } from '@posts-auto/services';
import { XMLParser } from 'fast-xml-parser';

export { isForbiddenAddress, plainText };
export const FEED_MAX_BYTES = SAFE_FETCH_MAX_BYTES;
export const FEED_TIMEOUT_MS = SAFE_FETCH_TIMEOUT_MS;

export class FeedError extends Error {
  override readonly name = 'FeedError';
}

export type FeedFetcher = (url: string) => Promise<string>;

/** Messages propres aux flux ; les autres refus gardent le message commun. */
function feedMessage(error: SafeFetchError): string {
  switch (error.code) {
    case 'injoignable':
      return 'Flux injoignable.';
    case 'statut':
      return `Le serveur du flux répond ${error.status}.`;
    case 'trop_volumineux':
      return 'Flux trop volumineux.';
    case 'vide':
      return 'Flux vide.';
    default:
      return error.message;
  }
}

/** Télécharge un flux en respectant les limites ; lève FeedError sinon. */
export const fetchFeedText: FeedFetcher = async (raw) => {
  try {
    const { text } = await safeFetchText(raw, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9', userAgent: 'PostsLinkedIn-Veille/1.0' });
    return text;
  } catch (error) {
    if (error instanceof SafeFetchError) throw new FeedError(feedMessage(error));
    throw error;
  }
};

export interface FeedItem {
  readonly guid: string;
  readonly title: string;
  readonly link: string | null;
  readonly summary: string | null;
  readonly publishedAt: Date | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  processEntities: true,
  htmlEntities: true,
  // Aucune entité externe n'est résolue par ce lecteur (pas d'attaque XXE).
  trimValues: true,
});

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) return text((value as Record<string, unknown>)['#text']);
  return null;
}


function httpLink(value: string | null): string | null {
  return value !== null && /^https?:\/\/\S+$/i.test(value) && value.length <= 1000 ? value : null;
}

function date(value: string | null): Date | null {
  if (value === null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/** Articles d'un flux RSS 2.0 ou Atom ; `null` si le document n'est pas un flux. */
export function parseFeed(xml: string): FeedItem[] | null {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rss = doc['rss'] as Record<string, unknown> | undefined;
  const channel = (rss?.['channel'] ?? (doc['rdf:RDF'] as Record<string, unknown> | undefined)) as Record<string, unknown> | undefined;
  const feed = doc['feed'] as Record<string, unknown> | undefined;
  const items: FeedItem[] = [];
  if (channel !== undefined) {
    for (const raw of asList(channel['item'] ?? (doc['rdf:RDF'] as Record<string, unknown> | undefined)?.['item'])) {
      const item = raw as Record<string, unknown>;
      const link = httpLink(text(item['link']));
      const title = text(item['title'])?.slice(0, 500) ?? null;
      const guid = text(item['guid']) ?? link ?? title;
      if (title === null || guid === null) continue;
      const summary = text(item['content:encoded']) ?? text(item['description']);
      items.push({ guid: guid.slice(0, 1000), title, link, summary: summary === null ? null : plainText(summary), publishedAt: date(text(item['pubDate']) ?? text(item['dc:date'])) });
    }
    return items;
  }
  if (feed !== undefined) {
    for (const raw of asList(feed['entry'])) {
      const entry = raw as Record<string, unknown>;
      const links = asList(entry['link']) as Record<string, unknown>[];
      const alternate = links.find((l) => l['@rel'] === undefined || l['@rel'] === 'alternate') ?? links[0];
      const link = httpLink(typeof alternate?.['@href'] === 'string' ? (alternate['@href'] as string) : null);
      const title = text(entry['title'])?.slice(0, 500) ?? null;
      const guid = text(entry['id']) ?? link ?? title;
      if (title === null || guid === null) continue;
      const summary = text(entry['summary']) ?? text(entry['content']);
      items.push({ guid: guid.slice(0, 1000), title, link, summary: summary === null ? null : plainText(summary), publishedAt: date(text(entry['updated']) ?? text(entry['published'])) });
    }
    return items;
  }
  return null;
}

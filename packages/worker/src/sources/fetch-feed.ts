/**
 * Lecture d'un flux RSS ou Atom (GEN-09), adresse saisie par un client.
 *
 * Sécurité (SSRF) : une adresse saisie par un client ne doit jamais permettre d'atteindre
 * le réseau interne de l'hébergement. Le contrôle porte sur l'adresse IP réellement
 * utilisée pour la connexion (résolveur personnalisé d'undici), à chaque redirection :
 * un nom qui changerait d'adresse entre deux résolutions ne passe pas non plus.
 * Ports 80 et 443 seulement, 2 Mo au plus, 10 secondes au plus, 3 redirections au plus.
 */
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import { Agent, fetch } from 'undici';

export const FEED_MAX_BYTES = 2 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export class FeedError extends Error {
  override readonly name = 'FeedError';
}

/** Adresse privée, locale, réservée ou de multidiffusion : jamais contactée. */
export function isForbiddenAddress(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/** Résolveur utilisé pour la connexion elle-même : refuse toute adresse interdite. */
function safeLookup(hostname: string, options: { all?: boolean } & Record<string, unknown>, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const list = addresses as { address: string; family: number }[];
    if (list.length === 0 || list.some((a) => isForbiddenAddress(a.address))) {
      return callback(Object.assign(new Error(`Adresse interdite pour ${hostname}`), { code: 'EFORBIDDEN' }), []);
    }
    if (options.all) return callback(null, list);
    const first = list[0] as { address: string; family: number };
    return callback(null, first.address, first.family);
  });
}

const agent = new Agent({ connect: { lookup: safeLookup as never, timeout: FEED_TIMEOUT_MS } });

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedError('Adresse invalide.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FeedError('Seules les adresses http et https sont acceptées.');
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw new FeedError('Port non autorisé.');
  if (url.username !== '' || url.password !== '') throw new FeedError('Adresse avec identifiants refusée.');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 && isForbiddenAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new FeedError('Adresse interdite.');
  return url;
}

export type FeedFetcher = (url: string) => Promise<string>;

/** Télécharge un flux en respectant les limites ; lève FeedError sinon. */
export const fetchFeedText: FeedFetcher = async (raw) => {
  let url = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetch(url, {
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9', 'user-agent': 'PostsLinkedIn-Veille/1.0' },
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      throw new FeedError(cause?.code === 'EFORBIDDEN' ? 'Adresse interdite.' : 'Flux injoignable.');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) throw new FeedError('Redirection sans destination.');
      url = checkUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new FeedError(`Le serveur du flux répond ${response.status}.`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > FEED_MAX_BYTES) throw new FeedError('Flux trop volumineux.');
    const reader = response.body?.getReader();
    if (!reader) throw new FeedError('Flux vide.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FEED_MAX_BYTES) {
        await reader.cancel();
        throw new FeedError('Flux trop volumineux.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new FeedError('Trop de redirections.');
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

/** Texte brut d'un résumé HTML : balises retirées, espaces réduits, 5 000 caractères au plus. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .slice(0, 5000);
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

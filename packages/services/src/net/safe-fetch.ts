/**
 * Lecture d'une adresse web saisie par un client (flux RSS, site de l'entreprise).
 *
 * Sécurité (SSRF) : une adresse saisie par un client ne doit jamais permettre d'atteindre
 * le réseau interne de l'hébergement. Le contrôle porte sur l'adresse IP réellement
 * utilisée pour la connexion (résolveur personnalisé d'undici), à chaque redirection :
 * un nom qui changerait d'adresse entre deux résolutions ne passe pas non plus.
 * Ports 80 et 443 seulement, taille et durée bornées, 3 redirections au plus.
 */
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';

export const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const SAFE_FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type SafeFetchErrorCode = 'invalide' | 'interdite' | 'injoignable' | 'statut' | 'trop_volumineux' | 'vide' | 'redirections';

export class SafeFetchError extends Error {
  override readonly name = 'SafeFetchError';
  readonly code: SafeFetchErrorCode;
  readonly status: number | null;
  constructor(code: SafeFetchErrorCode, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
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

const agent = new Agent({ connect: { lookup: safeLookup as never, timeout: SAFE_FETCH_TIMEOUT_MS } });

/** Adresse publique http(s) ; lève SafeFetchError sinon. */
export function checkPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('invalide', 'Adresse invalide.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('invalide', 'Seules les adresses http et https sont acceptées.');
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw new SafeFetchError('invalide', 'Port non autorisé.');
  if (url.username !== '' || url.password !== '') throw new SafeFetchError('invalide', 'Adresse avec identifiants refusée.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && isForbiddenAddress(host)) throw new SafeFetchError('interdite', 'Adresse interdite.');
  return url;
}

export interface SafeFetchOptions {
  readonly accept: string;
  readonly userAgent: string;
  readonly maxBytes?: number;
}

/** Télécharge un texte en respectant les limites ; lève SafeFetchError sinon. */
export async function safeFetchText(raw: string, options: SafeFetchOptions): Promise<{ readonly text: string; readonly url: string }> {
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  let url = checkPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetch(url, {
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS),
        headers: { accept: options.accept, 'user-agent': options.userAgent },
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      throw cause?.code === 'EFORBIDDEN' ? new SafeFetchError('interdite', 'Adresse interdite.') : new SafeFetchError('injoignable', 'Adresse injoignable.');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) throw new SafeFetchError('invalide', 'Redirection sans destination.');
      url = checkPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new SafeFetchError('statut', `Le serveur répond ${response.status}.`, response.status);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new SafeFetchError('trop_volumineux', 'Contenu trop volumineux.');
    const reader = response.body?.getReader();
    if (!reader) throw new SafeFetchError('vide', 'Contenu vide.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new SafeFetchError('trop_volumineux', 'Contenu trop volumineux.');
      }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), url: url.toString() };
  }
  throw new SafeFetchError('redirections', 'Trop de redirections.');
}

/** Texte brut d'un contenu HTML : balises retirées, espaces réduits, `max` caractères au plus. */
export function plainText(html: string, max = 5000): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|header|footer|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&rsquo;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .slice(0, max);
}

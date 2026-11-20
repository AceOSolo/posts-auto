/**
 * ONB-05 : charte proposée à partir du site web : couleurs, police des titres et logo.
 * Rien n'est enregistré : la proposition pré-remplit le formulaire de la charte, que la
 * personne corrige et valide. Le logo trouvé est gardé dans la médiathèque de l'espace
 * (étiquette « Logo du site ») pour pouvoir être choisi.
 *
 * Méthode, sans IA :
 * - couleurs : balise theme-color, variables CSS « primary », « brand », « accent »…, puis
 *   fréquence des couleurs dans la page et ses 2 premières feuilles de style ; les gris sont
 *   écartés pour la couleur principale et l'accent ; la couleur principale est assombrie si
 *   un texte blanc n'y serait pas lisible (contraste 4,5:1) ;
 * - police : familles déclarées, rapprochées des trois polices disponibles ;
 * - logo : image marquée « logo » dans la page, sinon icône Apple, sinon image de partage.
 * Lecture protégée comme les flux RSS : adresses internes refusées, taille limitée.
 */
import { randomUUID } from 'node:crypto';
import { type Database, asUser } from '@posts-auto/db';
import { type FontKey, contrastRatio } from '@posts-auto/visuals';
import { canManageContent, workspaceRole } from '../access.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { checkImage } from '../media/image-check.ts';
import { SafeFetchError, safeFetchBytes, safeFetchText } from '../net/safe-fetch.ts';

export interface BrandProposal {
  readonly primary: string;
  readonly secondary: string;
  readonly light: string;
  readonly dark: string;
  readonly font: FontKey;
  /** Image de la médiathèque, si un logo a été trouvé et accepté. */
  readonly logoAssetId: string | null;
  readonly sourceUrl: string;
  readonly notes: readonly string[];
}

const USER_AGENT = 'PostsLinkedIn/1.0 (charte ; +https://simplx.fr)';

type Rgb = readonly [number, number, number];
const hex = (rgb: Rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

function parseColor(raw: string): Rgb | null {
  const value = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) {
    const [r, g, b] = [short[1] ?? '0', short[2] ?? '0', short[3] ?? '0'];
    return [Number.parseInt(r + r, 16), Number.parseInt(g + g, 16), Number.parseInt(b + b, 16)];
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/.exec(value);
  if (long) return [Number.parseInt(long[1] as string, 16), Number.parseInt(long[2] as string, 16), Number.parseInt(long[3] as string, 16)];
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function hsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60 : max === gn ? ((bn - rn) / d + 2) * 60 : ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const COLOR_PATTERN = /#[0-9a-f]{3}(?:[0-9a-f]{3}(?:[0-9a-f]{2})?)?\b|rgba?\([^)]{5,40}\)/gi;

/** Couleurs pondérées : variables de marque et theme-color comptent plus que la fréquence. */
export function weightedColors(html: string, css: readonly string[]): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (raw: string, weight: number) => {
    const rgb = parseColor(raw);
    if (rgb !== null) weights.set(hex(rgb), (weights.get(hex(rgb)) ?? 0) + weight);
  };
  for (const m of html.matchAll(/<meta[^>]+name=["'](?:theme-color|msapplication-TileColor)["'][^>]*>/gi)) {
    const content = /content=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (content) add(content, 25);
  }
  const sources = [...css, ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? ''), ...[...html.matchAll(/style=["']([^"']+)["']/gi)].map((m) => m[1] ?? '')];
  for (const text of sources) {
    for (const v of text.matchAll(/--[\w-]*(?:primary|brand|main|accent|secondary|theme)[\w-]*\s*:\s*([^;}]+)/gi)) add(v[1] ?? '', 12);
    for (const c of text.matchAll(COLOR_PATTERN)) add(c[0], 1);
  }
  return weights;
}

/** Choisit les quatre couleurs de la charte. */
export function pickPalette(weights: Map<string, number>): { primary: string; secondary: string; light: string; dark: string } {
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]).map(([color, weight]) => ({ color, weight, ...hsl(parseColor(color) as Rgb) }));
  const vivid = ranked.filter((c) => c.s >= 0.25 && c.l >= 0.15 && c.l <= 0.8);
  let primary = vivid[0]?.color ?? '#0f3d5e';
  // Texte blanc lisible sur la couleur principale (visuels) : assombrir si besoin.
  for (let i = 0; i < 12 && contrastRatio('#ffffff', primary) < 4.5; i += 1) {
    const rgb = parseColor(primary) as Rgb;
    primary = hex([rgb[0] * 0.88, rgb[1] * 0.88, rgb[2] * 0.88]);
  }
  const primaryHue = hsl(parseColor(primary) as Rgb).h;
  const secondary = vivid.find((c) => hueDistance(c.h, primaryHue) >= 30)?.color ?? vivid[1]?.color ?? '#f0a500';
  const light = ranked.find((c) => c.l >= 0.92 && c.l < 1 && c.s <= 0.4)?.color ?? '#f5f7fa';
  const dark = ranked.find((c) => c.l <= 0.2 && c.l > 0)?.color ?? '#1a1a1a';
  return { primary, secondary, light, dark };
}

const SERIF = /serif\b(?!-)|georgia|times|playfair|merriweather|lora|garamond|libre baskerville|cormorant|crimson|pt serif/i;
const GEOMETRIC = /montserrat|poppins|raleway|futura|gotham|nunito|quicksand|avenir|century gothic|josefin|lexend|outfit|sora|urbanist/i;

/** Police des titres la plus proche parmi les trois disponibles. */
export function pickFont(html: string, css: readonly string[]): FontKey {
  const families = [...css, html].flatMap((t) => [...t.matchAll(/font-family\s*:\s*([^;}<>]+)/gi)].map((m) => (m[1] ?? '').replace(/&quot;/g, '"')));
  const googleFonts = [...html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&]+)/gi)].map((m) => decodeURIComponent(m[1] ?? '').replace(/\+/g, ' '));
  const first = [...googleFonts, ...families].find((f) => f.trim() !== '' && !/inherit|initial|var\(/i.test(f)) ?? '';
  const name = first.split(',')[0]?.replace(/["']/g, '').trim() ?? '';
  if (/^sans-serif$/i.test(name)) return 'inter';
  if (GEOMETRIC.test(name)) return 'montserrat';
  if (SERIF.test(name) && !/sans/i.test(name)) return 'lora';
  return 'inter';
}

/** Adresses de logo candidates, de la plus probable à la moins probable. */
export function logoCandidates(html: string, base: string): string[] {
  const urls: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw || raw.startsWith('data:')) return;
    try {
      urls.push(new URL(raw, base).toString());
    } catch {
      // adresse illisible : ignorée
    }
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (/logo/i.test(tag)) push(/\bsrc=["']([^"']+)["']/i.exec(tag)?.[1]);
  }
  push(/<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ?? /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']apple-touch-icon/i.exec(html)?.[1]);
  push(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1]);
  return [...new Set(urls)].filter((u) => !/\.svg(\?|$)/i.test(u)).slice(0, 5);
}

export async function proposeBrandFromWebsite(
  db: Database,
  media: MediaWriter,
  userId: string,
  workspaceId: string,
  website: string,
  now: Date,
  options: { readonly fetchText?: typeof safeFetchText; readonly fetchBytes?: typeof safeFetchBytes } = {},
): Promise<BrandProposal> {
  const fetchText = options.fetchText ?? safeFetchText;
  const fetchBytes = options.fetchBytes ?? safeFetchBytes;
  await asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    if (!canManageContent(role)) throw new ForbiddenError('editBranding');
  });
  const address = /^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`;
  let page: { text: string; url: string };
  try {
    page = await fetchText(address, { accept: 'text/html', userAgent: USER_AGENT, maxBytes: 1_500_000 });
  } catch (error) {
    if (error instanceof SafeFetchError) throw new RefusedError('site_illisible', `Site illisible : ${error.message}`);
    throw error;
  }
  const notes: string[] = [];
  const sheets = [...page.text.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1])
    .filter((h): h is string => h !== undefined && !/fonts\.googleapis/i.test(h))
    .slice(0, 2);
  const css: string[] = [];
  for (const href of sheets) {
    try {
      css.push((await fetchText(new URL(href, page.url).toString(), { accept: 'text/css', userAgent: USER_AGENT, maxBytes: 800_000 })).text);
    } catch {
      notes.push('Une feuille de style n’a pas pu être lue.');
    }
  }
  const palette = pickPalette(weightedColors(page.text, css));
  const font = pickFont(page.text, css);

  let logoAssetId: string | null = null;
  for (const candidate of logoCandidates(page.text, page.url)) {
    try {
      const file = await fetchBytes(candidate, { accept: 'image/png,image/jpeg,image/gif', userAgent: USER_AGENT, maxBytes: 2_000_000 });
      const checked = checkImage(file.bytes);
      if (!checked.ok) continue;
      logoAssetId = randomUUID();
      const extension = checked.mime === 'image/png' ? 'png' : checked.mime === 'image/gif' ? 'gif' : 'jpg';
      const storageKey = `${workspaceId}/charte/${logoAssetId}.${extension}`;
      await media.write(storageKey, checked.bytes);
      await asUser(db, userId, (trx) =>
        trx
          .insertInto('media_assets')
          .values({ id: logoAssetId as string, workspace_id: workspaceId, kind: 'upload', storage_key: storageKey, mime: checked.mime, bytes: checked.bytes.length, label: 'Logo du site', uploaded_by: userId, created_at: now })
          .execute(),
      );
      break;
    } catch {
      // candidat suivant
    }
  }
  if (logoAssetId === null) notes.push('Aucun logo exploitable trouvé (PNG, JPEG ou GIF) : ajoutez-le à la main.');
  return { ...palette, font, logoAssetId, sourceUrl: page.url, notes };
}

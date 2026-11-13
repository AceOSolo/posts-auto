/**
 * Modèles de visuels (VIS-01) : formats carré 1080×1080 et portrait 1080×1350, zones
 * nommées (titre, sous-titre, liste de 3 à 4 points, photo, logo, signature).
 *
 * Les coordonnées sont en pixels du visuel final. Une définition est une donnée JSON
 * (colonne templates.definition) : elle est validée ici avant tout rendu.
 */

export type TemplateFormat = 'square' | 'portrait';
export type ZoneKind = 'title' | 'subtitle' | 'bullets' | 'photo' | 'logo' | 'signature';
export type FontWeight = 400 | 600 | 700 | 800;

export const FORMAT_SIZES: Readonly<Record<TemplateFormat, { readonly width: number; readonly height: number }>> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
};

export const TEXT_KINDS: ReadonlySet<ZoneKind> = new Set<ZoneKind>(['title', 'subtitle', 'bullets', 'signature']);
export const IMAGE_KINDS: ReadonlySet<ZoneKind> = new Set<ZoneKind>(['photo', 'logo']);

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TextStyle {
  readonly color: string;
  readonly weight: FontWeight;
  /** Taille de police essayée d'abord ; elle diminue jusqu'à `minSize` pour que le texte tienne. */
  readonly maxSize: number;
  /** En dessous, le texte n'est plus lisible sur téléphone (VIS-03). */
  readonly minSize: number;
  readonly align: 'left' | 'center' | 'right';
  /** Position verticale du texte dans sa zone (haut par défaut). */
  readonly valign?: 'top' | 'middle' | 'bottom';
  readonly lineHeight: number;
  /** Fond de la zone (bandeau) ; sinon le fond du visuel. */
  readonly background?: string;
  readonly padding?: number;
  readonly uppercase?: boolean;
}

export interface Zone {
  readonly key: string;
  readonly kind: ZoneKind;
  readonly box: Box;
  /** Zones de texte. */
  readonly style?: TextStyle;
  /** Zones d'image : recadrée pour remplir (`cover`) ou contenue entière (`contain`). */
  readonly fit?: 'cover' | 'contain';
  readonly radius?: number;
  /** Voile sombre sur la photo, pour la lisibilité d'un texte posé dessus (0 à 1). */
  readonly overlay?: number;
}

export interface TemplateDefinition {
  readonly format: TemplateFormat;
  readonly background: string;
  /** Bandeau de couleur décoratif (facultatif). */
  readonly accent?: { readonly color: string; readonly box: Box };
  readonly zones: readonly Zone[];
}

/** Contenu d'un visuel : textes courts tirés du post (VIS-03), images. */
export interface TemplateContent {
  readonly title?: string;
  readonly subtitle?: string;
  readonly bullets?: readonly string[];
  readonly signature?: string;
  readonly photo?: Uint8Array | null;
  readonly logo?: Uint8Array | null;
}

const COLOR = /^#[0-9a-f]{6}$/i;
const WEIGHTS: readonly FontWeight[] = [400, 600, 700, 800];
const KINDS: readonly ZoneKind[] = ['title', 'subtitle', 'bullets', 'photo', 'logo', 'signature'];

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
}

function num(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new TemplateError(`${name} : nombre entre ${min} et ${max} attendu.`);
  return value;
}

function color(value: unknown, name: string): string {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new TemplateError(`${name} : couleur #rrggbb attendue.`);
  return value.toLowerCase();
}

function box(raw: unknown, name: string, width: number, height: number): Box {
  const b = (raw ?? {}) as Record<string, unknown>;
  const x = num(b['x'], `${name}.x`, 0, width - 1);
  const y = num(b['y'], `${name}.y`, 0, height - 1);
  return { x, y, w: num(b['w'], `${name}.w`, 1, width - x), h: num(b['h'], `${name}.h`, 1, height - y) };
}

/** Valide une définition enregistrée ; lève TemplateError avec un message lisible. */
export function parseTemplate(raw: unknown): TemplateDefinition {
  const t = (raw ?? {}) as Record<string, unknown>;
  const format = t['format'];
  if (format !== 'square' && format !== 'portrait') throw new TemplateError('format : « square » ou « portrait ».');
  const { width, height } = FORMAT_SIZES[format];
  if (!Array.isArray(t['zones']) || t['zones'].length === 0 || t['zones'].length > 12) throw new TemplateError('zones : 1 à 12 zones.');
  const keys = new Set<string>();
  const zones = (t['zones'] as unknown[]).map((rawZone, i): Zone => {
    const z = (rawZone ?? {}) as Record<string, unknown>;
    const key = typeof z['key'] === 'string' && /^[a-z][a-z0-9_-]{0,30}$/.test(z['key']) ? z['key'] : null;
    if (key === null || keys.has(key)) throw new TemplateError(`zones[${i}].key : identifiant unique attendu.`);
    keys.add(key);
    const kind = z['kind'];
    if (!KINDS.includes(kind as ZoneKind)) throw new TemplateError(`zones[${i}].kind : ${KINDS.join(', ')}.`);
    const zone: Zone = { key, kind: kind as ZoneKind, box: box(z['box'], `zones[${i}].box`, width, height) };
    if (TEXT_KINDS.has(kind as ZoneKind)) {
      const s = (z['style'] ?? {}) as Record<string, unknown>;
      const maxSize = num(s['maxSize'], `zones[${i}].style.maxSize`, 12, 200);
      const style: TextStyle = {
        color: color(s['color'], `zones[${i}].style.color`),
        weight: WEIGHTS.includes(s['weight'] as FontWeight) ? (s['weight'] as FontWeight) : 400,
        maxSize,
        minSize: num(s['minSize'] ?? Math.min(28, maxSize), `zones[${i}].style.minSize`, 12, maxSize),
        align: s['align'] === 'center' || s['align'] === 'right' ? s['align'] : 'left',
        ...((s['valign'] === 'middle' || s['valign'] === 'bottom') && { valign: s['valign'] }),
        lineHeight: num(s['lineHeight'] ?? 1.2, `zones[${i}].style.lineHeight`, 0.9, 2),
        ...(s['background'] !== undefined && { background: color(s['background'], `zones[${i}].style.background`) }),
        ...(s['padding'] !== undefined && { padding: num(s['padding'], `zones[${i}].style.padding`, 0, 200) }),
        ...(s['uppercase'] === true && { uppercase: true }),
      };
      return { ...zone, style };
    }
    return {
      ...zone,
      fit: z['fit'] === 'contain' ? 'contain' : kind === 'logo' ? 'contain' : 'cover',
      ...(z['radius'] !== undefined && { radius: num(z['radius'], `zones[${i}].radius`, 0, 540) }),
      ...(z['overlay'] !== undefined && { overlay: num(z['overlay'], `zones[${i}].overlay`, 0, 0.9) }),
    };
  });
  const accent = t['accent'] === undefined ? undefined : (t['accent'] as Record<string, unknown>);
  return {
    format,
    background: color(t['background'], 'background'),
    ...(accent !== undefined && { accent: { color: color(accent['color'], 'accent.color'), box: box(accent['box'], 'accent.box', width, height) } }),
    zones,
  };
}

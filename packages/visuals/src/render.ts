/**
 * Rendu PNG d'un modèle (VIS-03), côté serveur, avec contrôle de qualité (VIS-11) :
 * - le texte prend la plus grande taille qui tient dans sa zone, sans descendre sous la
 *   taille minimale lisible sur téléphone ; sinon il est coupé et le problème est signalé ;
 * - un contraste insuffisant entre le texte et son fond est signalé ;
 * - une zone de texte ou de photo restée vide est signalée.
 */
import { type Image, GlobalFonts, type SKRSContext2D, createCanvas, loadImage } from '@napi-rs/canvas';
import { contrastRatio } from './contrast.ts';
import { FONTS, FORMAT_SIZES, IMAGE_KINDS, type TemplateContent, type TemplateDefinition, type TextStyle, type Zone } from './template.ts';

let fontsReady = false;

/**
 * Police Inter (licence OFL), embarquée : le rendu ne dépend pas des polices du serveur.
 *
 * Le chemin des fichiers est résolu à l'exécution, par Node : `createRequire` est obtenu par
 * `process.getBuiltinModule` pour que l'empaqueteur de Next.js ne remplace pas
 * `require.resolve(…)` par un identifiant de module (un nombre, refusé par le moteur).
 */
function registerFonts(): void {
  if (fontsReady) return;
  const { createRequire } = process.getBuiltinModule('node:module');
  const resolve = createRequire(import.meta.url).resolve;
  for (const [key, font] of Object.entries(FONTS)) {
    for (const weight of font.weights) {
      const file = resolve(['@fontsource', key, 'files', `${key}-latin-${weight}-normal.woff2`].join('/'));
      GlobalFonts.registerFromPath(file, font.family);
    }
  }
  fontsReady = true;
}

/** Police CSS d'une zone ; la graisse absente d'une police est remplacée par la plus proche. */
const fontOf = (style: TextStyle, size: number) => `${style.weight} ${size}px ${FONTS[style.font ?? 'inter'].family}`;

export type RenderIssueCode = 'text_truncated' | 'low_contrast' | 'empty_zone';

export interface RenderIssue {
  readonly code: RenderIssueCode;
  readonly zone: string;
  readonly message: string;
}

export interface RenderResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly issues: readonly RenderIssue[];
}

/** Contraste minimal (WCAG AA, texte normal). */
export const MIN_CONTRAST = 4.5;

function textOf(zone: Zone, content: TemplateContent): string[] {
  switch (zone.kind) {
    case 'title':
      return content.title ? [content.title] : [];
    case 'subtitle':
      return content.subtitle ? [content.subtitle] : [];
    case 'signature':
      return content.signature ? [content.signature] : [];
    case 'bullets':
      return (content.bullets ?? []).filter((b) => b.trim() !== '').slice(0, 4);
    default:
      return [];
  }
}

const NBSP = ' ';

/**
 * Espaces insécables de la typographie française : « : », « ? », « % »… ne commencent
 * jamais une ligne, un nombre ou un mot d'une ou deux lettres (« 5 », « à », « le ») ne la
 * termine jamais.
 */
export function frenchSpacing(text: string): string {
  const words = text.split(/ +/);
  let out = words[0] ?? '';
  for (let i = 1; i < words.length; i += 1) {
    const previous = words[i - 1] ?? '';
    const word = words[i] ?? '';
    const letters = previous.replace(/[^\p{L}\p{N}]/gu, '').length;
    const glue = /^[:;!?»%€]/.test(word) || previous === '«' || /^\d[\d.,]*$/.test(previous) || (letters > 0 && letters <= 2);
    out += (glue ? NBSP : ' ') + word;
  }
  return out;
}

/** Découpe en lignes qui tiennent dans `width` ; un mot trop long est coupé lettre par lettre. */
function wrap(ctx: SKRSContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    // Coupure sur les espaces ordinaires seulement : les insécables tiennent les mots ensemble.
    for (const word of frenchSpacing(paragraph.replace(/[ \t]+/g, ' ').trim()).split(' ').filter(Boolean)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (ctx.measureText(candidate).width <= width) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      if (ctx.measureText(word).width <= width) {
        line = word;
        continue;
      }
      // Mot plus large que la zone (adresse, mot composé) : coupé.
      let part = '';
      for (const ch of word) {
        if (ctx.measureText(part + ch).width > width && part !== '') {
          lines.push(part);
          part = ch;
        } else part += ch;
      }
      line = part;
    }
    lines.push(line);
  }
  return lines;
}

interface Layout {
  readonly size: number;
  readonly blocks: readonly string[][];
  readonly fits: boolean;
}

/** Plus grande taille de police pour laquelle tous les blocs (titre, ou points d'une liste) tiennent. */
function layout(ctx: SKRSContext2D, blocks: readonly string[], style: TextStyle, width: number, height: number, bulletIndent: number): Layout {
  for (let size = style.maxSize; size >= style.minSize; size -= 2) {
    ctx.font = fontOf(style, size);
    const wrapped = blocks.map((b) => wrap(ctx, style.uppercase ? b.toUpperCase() : b, width - bulletIndent * size));
    const lines = wrapped.reduce((n, w) => n + w.length, 0);
    const gaps = Math.max(0, wrapped.length - 1) * size * 0.5;
    if (lines * size * style.lineHeight + gaps <= height) return { size, blocks: wrapped, fits: true };
  }
  const size = style.minSize;
  ctx.font = fontOf(style, size);
  return { size, blocks: blocks.map((b) => wrap(ctx, style.uppercase ? b.toUpperCase() : b, width - bulletIndent * size)), fits: false };
}

/** Raccourcit une ligne pour qu'elle tienne avec « … » à la fin. */
function ellipsize(ctx: SKRSContext2D, text: string, width: number): string {
  let value = text;
  while (value !== '' && ctx.measureText(`${value}…`).width > width) value = value.slice(0, -1);
  return `${value.trimEnd()}…`;
}

function roundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawImage(ctx: SKRSContext2D, image: Image, zone: Zone): void {
  const { x, y, w, h } = zone.box;
  const ratio = zone.fit === 'contain' ? Math.min(w / image.width, h / image.height) : Math.max(w / image.width, h / image.height);
  const dw = image.width * ratio;
  const dh = image.height * ratio;
  ctx.save();
  if (zone.radius) {
    roundedRect(ctx, x, y, w, h, zone.radius);
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  }
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  if (zone.overlay) {
    ctx.fillStyle = `rgba(0, 0, 0, ${zone.overlay})`;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

/** Dimensions réelles d'une image (PNG, JPEG, GIF) ; lève une erreur si elle est illisible. */
export async function imageSize(bytes: Uint8Array): Promise<{ readonly width: number; readonly height: number }> {
  const image = await loadImage(Buffer.from(bytes));
  return { width: image.width, height: image.height };
}

export async function renderTemplate(definition: TemplateDefinition, content: TemplateContent): Promise<RenderResult> {
  registerFonts();
  const { width, height } = FORMAT_SIZES[definition.format];
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const issues: RenderIssue[] = [];

  ctx.fillStyle = definition.background;
  ctx.fillRect(0, 0, width, height);
  if (definition.accent) {
    ctx.fillStyle = definition.accent.color;
    ctx.fillRect(definition.accent.box.x, definition.accent.box.y, definition.accent.box.w, definition.accent.box.h);
  }

  // Images d'abord, textes ensuite (un titre peut être posé sur une photo).
  for (const zone of definition.zones.filter((z) => IMAGE_KINDS.has(z.kind))) {
    const bytes = zone.kind === 'photo' ? content.photo : content.logo;
    if (!bytes) {
      if (zone.kind === 'photo') issues.push({ code: 'empty_zone', zone: zone.key, message: 'Zone photo sans image.' });
      continue;
    }
    drawImage(ctx, await loadImage(Buffer.from(bytes)), zone);
  }

  for (const zone of definition.zones.filter((z) => !IMAGE_KINDS.has(z.kind))) {
    const style = zone.style as TextStyle;
    const blocks = textOf(zone, content);
    if (blocks.length === 0) {
      if (zone.kind === 'title' || zone.kind === 'bullets') issues.push({ code: 'empty_zone', zone: zone.key, message: `Zone « ${zone.key} » sans texte.` });
      continue;
    }
    const pad = style.padding ?? 0;
    const { x, y, w, h } = zone.box;
    if (style.background) {
      ctx.fillStyle = style.background;
      ctx.fillRect(x, y, w, h);
    }
    const background = style.background ?? (zone.kind === 'title' && definition.zones.some((z) => z.kind === 'photo' && z.overlay) ? '#000000' : definition.background);
    const ratio = contrastRatio(style.color, background);
    if (ratio < MIN_CONTRAST) issues.push({ code: 'low_contrast', zone: zone.key, message: `Contraste insuffisant (${ratio.toFixed(1)} pour ${MIN_CONTRAST} au moins).` });

    const bullet = zone.kind === 'bullets';
    const result = layout(ctx, blocks, style, w - 2 * pad, h - 2 * pad, bullet ? 1.1 : 0);
    if (!result.fits) issues.push({ code: 'text_truncated', zone: zone.key, message: `Texte trop long pour la zone « ${zone.key} » : coupé.` });
    ctx.font = fontOf(style, result.size);
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'top';
    const size = result.size;
    const lineStep = size * style.lineHeight;
    const indent = bullet ? 1.1 * size : 0;
    const left = x + pad + indent;
    const right = x + w - pad;

    // Placement : les lignes qui tiennent ; si le texte est coupé, la dernière finit par « … ».
    const lines = result.blocks.flatMap((block, b) => block.map((text, i) => ({ text, first: i === 0, gapBefore: i === 0 && b > 0 })));
    const placed: { text: string; first: boolean; top: number }[] = [];
    let cursor = y + pad;
    for (const line of lines) {
      const top = cursor + (line.gapBefore ? size * 0.5 : 0);
      if (top + lineStep > y + h - pad + 0.5) break;
      placed.push({ text: line.text, first: line.first, top });
      cursor = top + lineStep;
    }
    const last = placed.at(-1);
    if (last !== undefined && placed.length < lines.length) last.text = ellipsize(ctx, last.text, right - left);
    const free = Math.max(0, y + h - pad - cursor);
    const shift = style.valign === 'middle' ? free / 2 : style.valign === 'bottom' ? free : 0;

    for (const line of placed) {
      line.top += shift;
      if (bullet && line.first) {
        ctx.textAlign = 'left';
        ctx.fillText('•', x + pad, line.top);
      }
      ctx.textAlign = style.align;
      ctx.fillText(line.text, style.align === 'left' ? left : style.align === 'right' ? right : (left + right) / 2, line.top);
    }
  }

  return { png: new Uint8Array(await canvas.encode('png')), width, height, issues };
}

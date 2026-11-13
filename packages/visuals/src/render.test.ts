import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.ts';
import { DEFAULT_BRAND, galleryTemplates, parseBrand } from './gallery.ts';
import { FakeImageGenerator, IMAGE_RULES, imagePrompt } from './image-generator.ts';
import { frenchSpacing, renderTemplate } from './render.ts';
import { type TemplateDefinition, TemplateError, parseTemplate } from './template.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function pixel(png: Uint8Array, x: number, y: number): Promise<string> {
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function template(key: string): TemplateDefinition {
  const found = galleryTemplates().find((t) => t.key === key);
  if (!found) throw new Error(key);
  return found.definition;
}

const photo = async (subject: string, width = 1200, height = 800) => (await new FakeImageGenerator().generate({ subject, width, height })).bytes;

describe('contraste', () => {
  it('suit la formule WCAG', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#ffffff', '#0f3d5e')).toBeGreaterThan(4.5);
    expect(contrastRatio('#cccccc', '#ffffff')).toBeLessThan(4.5);
  });
});

describe('modèles de départ', () => {
  it('passent tous la validation, à l’identique, après un aller-retour JSON', () => {
    for (const t of galleryTemplates()) {
      expect(parseTemplate(JSON.parse(JSON.stringify(t.definition)))).toEqual(t.definition);
    }
  });

  it('prennent les couleurs de l’espace ; une couleur invalide garde la valeur par défaut', () => {
    const brand = parseBrand({ primary: '#AA0000', secondary: 'rouge', light: 12 });
    expect(brand).toEqual({ ...DEFAULT_BRAND, primary: '#aa0000' });
    expect(parseBrand(null)).toEqual(DEFAULT_BRAND);
    expect(galleryTemplates(brand).find((t) => t.key === 'titre-points')?.definition.background).toBe('#aa0000');
  });

  it('se rendent sans problème avec un contenu complet', async () => {
    const content = {
      title: 'Évaluer les risques : 5 erreurs à éviter',
      subtitle: 'Marie Dupont, préventrice',
      bullets: ['Oublier les postes temporaires', 'Copier le document de l’an dernier', 'Ne pas associer les salariés'],
      signature: 'Secutop · prévention',
      photo: await photo('atelier de menuiserie'),
      logo: await photo('logo', 300, 120),
    };
    for (const t of galleryTemplates()) {
      const result = await renderTemplate(t.definition, content);
      expect(result.issues, t.key).toEqual([]);
      expect([...result.png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
      expect(result.width).toBe(1080);
      expect(result.height).toBe(t.definition.format === 'square' ? 1080 : 1350);
    }
  });
});

describe('rendu', () => {
  it('peint le fond et le bandeau aux couleurs du modèle', async () => {
    const result = await renderTemplate(template('titre-points'), { title: 'Titre', bullets: ['Un', 'Deux', 'Trois'] });
    expect(await pixel(result.png, 5, 500)).toBe(DEFAULT_BRAND.secondary);
    expect(await pixel(result.png, 1070, 1070)).toBe(DEFAULT_BRAND.primary);
  });

  it('pose le texte dans sa zone et nulle part ailleurs', async () => {
    const definition = parseTemplate({
      format: 'square',
      background: '#ffffff',
      zones: [{ key: 'titre', kind: 'title', box: { x: 100, y: 100, w: 400, h: 200 }, style: { color: '#000000', maxSize: 80, minSize: 20 } }],
    });
    const result = await renderTemplate(definition, { title: 'MMMM MMMM MMMM MMMM MMMM MMMM' });
    expect(result.issues).toEqual([]);
    const image = await loadImage(Buffer.from(result.png));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, 1080, 1080).data;
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < 1080; y += 2) {
      for (let x = 0; x < 1080; x += 2) {
        const dark = (data[(y * 1080 + x) * 4] ?? 255) < 128;
        if (!dark) continue;
        if (x >= 100 && x < 500 && y >= 100 && y < 300) inside += 1;
        else outside += 1;
      }
    }
    expect(inside).toBeGreaterThan(500);
    expect(outside).toBe(0);
  });

  it('réduit la police pour qu’un texte long tienne, sans le couper', async () => {
    const result = await renderTemplate(template('titre-points'), {
      title: 'Document unique : ce que l’inspection du travail vérifie en premier lors d’un contrôle en entreprise',
      bullets: ['Un', 'Deux', 'Trois'],
    });
    expect(result.issues).toEqual([]);
  });

  it('coupe un texte trop long même à la taille minimale, et le signale', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `mot${i}`).join(' ');
    const result = await renderTemplate(template('titre-points'), { title: long, bullets: ['Un', 'Deux', 'Trois'] });
    expect(result.issues).toEqual([expect.objectContaining({ code: 'text_truncated', zone: 'titre' })]);
  });

  it('coupe un mot plus large que la zone au lieu de déborder', async () => {
    const result = await renderTemplate(template('titre-points'), { title: 'https://www.exemple-de-site-tres-long.fr/une/adresse/sans/espace', bullets: ['Un', 'Deux'] });
    expect(result.issues.filter((i) => i.code === 'text_truncated')).toEqual([]);
  });

  it('ne garde que quatre points au plus', async () => {
    const four = await renderTemplate(template('titre-points'), { title: 'Titre', bullets: ['Un', 'Deux', 'Trois', 'Quatre'] });
    const six = await renderTemplate(template('titre-points'), { title: 'Titre', bullets: ['Un', 'Deux', 'Trois', 'Quatre', 'Cinq', 'Six'] });
    expect(Buffer.from(six.png).equals(Buffer.from(four.png))).toBe(true);
  });

  it('signale un contraste insuffisant', async () => {
    const definition = parseTemplate({
      format: 'square',
      background: '#ffffff',
      zones: [{ key: 'titre', kind: 'title', box: { x: 100, y: 100, w: 800, h: 300 }, style: { color: '#dddddd', maxSize: 60 } }],
    });
    const result = await renderTemplate(definition, { title: 'Peu lisible' });
    expect(result.issues).toEqual([expect.objectContaining({ code: 'low_contrast', zone: 'titre' })]);
  });

  it('mesure le contraste sur le bandeau de la zone, pas sur le fond du visuel', async () => {
    const definition = parseTemplate({
      format: 'square',
      background: '#ffffff',
      zones: [{ key: 'titre', kind: 'title', box: { x: 0, y: 0, w: 1080, h: 300 }, style: { color: '#ffffff', maxSize: 60, background: '#0f3d5e', padding: 40 } }],
    });
    const result = await renderTemplate(definition, { title: 'Blanc sur bandeau' });
    expect(result.issues).toEqual([]);
    expect(await pixel(result.png, 2, 2)).toBe('#0f3d5e');
  });

  it('signale une photo ou un titre manquant, mais pas un logo ou une signature', async () => {
    const result = await renderTemplate(template('photo-titre'), {});
    expect(result.issues.map((i) => `${i.code}:${i.zone}`).sort()).toEqual(['empty_zone:photo', 'empty_zone:titre']);
  });

  it('recadre la photo pour remplir sa zone et assombrit le voile', async () => {
    const image = await photo('chantier', 400, 1600);
    const plain = await renderTemplate(template('photo-titre'), { title: 'Titre', photo: image });
    // Zone photo 1080×640 entièrement couverte : aucun pixel du fond clair dans ses coins.
    expect(await pixel(plain.png, 2, 2)).not.toBe(DEFAULT_BRAND.light);
    expect(await pixel(plain.png, 1077, 637)).not.toBe(DEFAULT_BRAND.light);

    const veiled = await renderTemplate(template('photo-pleine'), { title: 'Titre', photo: image });
    const raw = await renderTemplate({ ...template('photo-pleine'), zones: template('photo-pleine').zones.map((z) => (z.kind === 'photo' ? { ...z, overlay: 0 } : z)) }, { title: 'Titre', photo: image });
    const brightness = (hex: string) => Number.parseInt(hex.slice(1, 3), 16) + Number.parseInt(hex.slice(3, 5), 16) + Number.parseInt(hex.slice(5, 7), 16);
    expect(brightness(await pixel(veiled.png, 40, 40))).toBeLessThan(brightness(await pixel(raw.png, 40, 40)));
  });

  it('cale le texte en haut, au milieu ou en bas de sa zone', async () => {
    const at = async (valign: string) => {
      const definition = parseTemplate({
        format: 'square',
        background: '#ffffff',
        zones: [{ key: 'titre', kind: 'title', box: { x: 0, y: 0, w: 1080, h: 1080 }, style: { color: '#000000', maxSize: 60, valign } }],
      });
      const { png } = await renderTemplate(definition, { title: 'Court' });
      const image = await loadImage(Buffer.from(png));
      const canvas = createCanvas(1080, 1080);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, 1080, 1080).data;
      const rows: number[] = [];
      for (let y = 0; y < 1080; y += 1) {
        for (let x = 0; x < 400; x += 1) {
          if ((data[(y * 1080 + x) * 4] ?? 255) < 128) {
            rows.push(y);
            break;
          }
        }
      }
      return ((rows[0] ?? 0) + (rows.at(-1) ?? 0)) / 2;
    };
    expect(await at('top')).toBeLessThan(100);
    expect(Math.abs((await at('middle')) - 540)).toBeLessThan(40);
    expect(await at('bottom')).toBeGreaterThan(980);
  });

  it('applique les espaces insécables du français', () => {
    expect(frenchSpacing('Évaluer les risques : 5 erreurs à éviter')).toBe('Évaluer les risques : 5 erreurs à éviter');
    expect(frenchSpacing('« Prévenir » ou guérir ? 30 % des cas')).toBe('« Prévenir » ou guérir ? 30 % des cas');
  });

  it('donne le même PNG pour le même contenu', async () => {
    const content = { title: 'Même titre', bullets: ['A', 'B', 'C'] };
    const a = await renderTemplate(template('titre-points'), content);
    const b = await renderTemplate(template('titre-points'), content);
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
  });
});

describe('validation des modèles', () => {
  const base = { format: 'square', background: '#ffffff', zones: [{ key: 'titre', kind: 'title', box: { x: 0, y: 0, w: 100, h: 100 }, style: { color: '#000000', maxSize: 40 } }] };

  it.each([
    ['format inconnu', { ...base, format: 'paysage' }, /format/],
    ['aucune zone', { ...base, zones: [] }, /zones/],
    ['couleur de fond invalide', { ...base, background: 'blanc' }, /background/],
    ['zone hors du visuel', { ...base, zones: [{ ...base.zones[0], box: { x: 1000, y: 0, w: 200, h: 100 } }] }, /box\.w/],
    ['clé en double', { ...base, zones: [base.zones[0], base.zones[0]] }, /key/],
    ['type de zone inconnu', { ...base, zones: [{ ...base.zones[0], kind: 'video' }] }, /kind/],
    ['taille minimale au-dessus de la maximale', { ...base, zones: [{ ...base.zones[0], style: { color: '#000000', maxSize: 40, minSize: 60 } }] }, /minSize/],
    ['voile trop opaque', { ...base, zones: [{ key: 'photo', kind: 'photo', box: { x: 0, y: 0, w: 10, h: 10 }, overlay: 1 }] }, /overlay/],
  ])('refuse : %s', (_label, raw, message) => {
    expect(() => parseTemplate(raw)).toThrow(TemplateError);
    expect(() => parseTemplate(raw)).toThrow(message);
  });

  it('complète les valeurs par défaut', () => {
    const parsed = parseTemplate({
      ...base,
      zones: [...base.zones, { key: 'logo', kind: 'logo', box: { x: 0, y: 900, w: 100, h: 100 } }, { key: 'photo', kind: 'photo', box: { x: 200, y: 200, w: 100, h: 100 } }],
    });
    expect(parsed.zones[0]?.style).toEqual({ color: '#000000', weight: 400, maxSize: 40, minSize: 28, align: 'left', lineHeight: 1.2 });
    expect(parsed.zones[1]?.fit).toBe('contain');
    expect(parsed.zones[2]?.fit).toBe('cover');
  });
});

describe('générateur d’images simulé', () => {
  it('ajoute les règles à la consigne et produit une image à la taille demandée', async () => {
    const generator = new FakeImageGenerator();
    const image = await generator.generate({ subject: '  bureau   lumineux ', width: 640, height: 400 });
    expect(image.prompt).toBe(`bureau lumineux. ${IMAGE_RULES}`);
    expect(imagePrompt('x'.repeat(1000)).length).toBe(400 + 2 + IMAGE_RULES.length);
    const decoded = await loadImage(Buffer.from(image.bytes));
    expect([decoded.width, decoded.height]).toEqual([640, 400]);
    expect(generator.requests).toHaveLength(1);
  });

  it('est déterministe pour un même sujet', async () => {
    const a = await new FakeImageGenerator().generate({ subject: 'entrepôt', width: 100, height: 100 });
    const b = await new FakeImageGenerator().generate({ subject: 'entrepôt', width: 100, height: 100 });
    const c = await new FakeImageGenerator().generate({ subject: 'bureau', width: 100, height: 100 });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(c.bytes))).toBe(false);
  });
});

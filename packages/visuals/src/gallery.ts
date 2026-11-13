/**
 * Modèles de départ (VIS-01, ADM-05), aux couleurs de l'espace. Chaque espace en reçoit une
 * copie qu'il modifie ensuite à sa guise (VIS-02).
 */
import type { TemplateDefinition } from './template.ts';

export interface Brand {
  /** Couleur principale (fonds, bandeaux). */
  readonly primary: string;
  /** Couleur d'accent (signature, détails). */
  readonly secondary: string;
  /** Fond clair et texte sombre. */
  readonly light: string;
  readonly dark: string;
}

export const DEFAULT_BRAND: Brand = { primary: '#0f3d5e', secondary: '#f0a500', light: '#f5f7fa', dark: '#1a1a1a' };

const COLOR = /^#[0-9a-f]{6}$/i;

/** Charte de l'espace (colonne workspaces.branding) ; toute valeur absente ou invalide prend la valeur par défaut. */
export function parseBrand(raw: unknown): Brand {
  const b = (raw ?? {}) as Record<string, unknown>;
  const pick = (key: keyof Brand) => (typeof b[key] === 'string' && COLOR.test(b[key] as string) ? (b[key] as string).toLowerCase() : DEFAULT_BRAND[key]);
  return { primary: pick('primary'), secondary: pick('secondary'), light: pick('light'), dark: pick('dark') };
}

export interface GalleryTemplate {
  readonly key: string;
  readonly name: string;
  /** Avec une photo (image générée ou photo réelle) ou visuel texte (VIS-04). */
  readonly withPhoto: boolean;
  readonly definition: TemplateDefinition;
}

export function galleryTemplates(brand: Brand = DEFAULT_BRAND): GalleryTemplate[] {
  return [
    {
      key: 'titre-points',
      name: 'Titre et points clés',
      withPhoto: false,
      definition: {
        format: 'square',
        background: brand.primary,
        accent: { color: brand.secondary, box: { x: 0, y: 0, w: 18, h: 1080 } },
        zones: [
          { key: 'titre', kind: 'title', box: { x: 80, y: 90, w: 920, h: 300 }, style: { color: '#ffffff', weight: 800, maxSize: 76, minSize: 40, align: 'left', lineHeight: 1.15 } },
          { key: 'points', kind: 'bullets', box: { x: 80, y: 420, w: 920, h: 460 }, style: { color: '#ffffff', weight: 600, maxSize: 46, minSize: 28, align: 'left', lineHeight: 1.3 } },
          { key: 'signature', kind: 'signature', box: { x: 80, y: 950, w: 760, h: 60 }, style: { color: brand.secondary, weight: 600, maxSize: 30, minSize: 22, align: 'left', lineHeight: 1.2 } },
          { key: 'logo', kind: 'logo', box: { x: 880, y: 930, w: 120, h: 100 }, fit: 'contain' },
        ],
      },
    },
    {
      key: 'photo-titre',
      name: 'Photo et titre',
      withPhoto: true,
      definition: {
        format: 'square',
        background: brand.light,
        zones: [
          { key: 'photo', kind: 'photo', box: { x: 0, y: 0, w: 1080, h: 640 }, fit: 'cover' },
          { key: 'titre', kind: 'title', box: { x: 0, y: 640, w: 1080, h: 300 }, style: { color: '#ffffff', weight: 800, maxSize: 64, minSize: 36, align: 'left', valign: 'middle', lineHeight: 1.15, background: brand.primary, padding: 60 } },
          { key: 'signature', kind: 'signature', box: { x: 60, y: 970, w: 760, h: 60 }, style: { color: brand.dark, weight: 600, maxSize: 30, minSize: 22, align: 'left', lineHeight: 1.2 } },
          { key: 'logo', kind: 'logo', box: { x: 880, y: 950, w: 140, h: 100 }, fit: 'contain' },
        ],
      },
    },
    {
      key: 'citation',
      name: 'Citation',
      withPhoto: false,
      definition: {
        format: 'portrait',
        background: brand.primary,
        // La citation se cale en bas de sa zone : citation, trait et auteur restent groupés.
        accent: { color: brand.secondary, box: { x: 480, y: 830, w: 120, h: 8 } },
        zones: [
          { key: 'citation', kind: 'title', box: { x: 100, y: 160, w: 880, h: 630 }, style: { color: '#ffffff', weight: 700, maxSize: 72, minSize: 36, align: 'center', valign: 'bottom', lineHeight: 1.2 } },
          { key: 'auteur', kind: 'subtitle', box: { x: 100, y: 870, w: 880, h: 120 }, style: { color: brand.secondary, weight: 600, maxSize: 36, minSize: 24, align: 'center', lineHeight: 1.2 } },
          { key: 'logo', kind: 'logo', box: { x: 440, y: 1150, w: 200, h: 120 }, fit: 'contain' },
        ],
      },
    },
    {
      key: 'photo-pleine',
      name: 'Photo pleine page',
      withPhoto: true,
      definition: {
        format: 'portrait',
        background: brand.dark,
        zones: [
          { key: 'photo', kind: 'photo', box: { x: 0, y: 0, w: 1080, h: 1350 }, fit: 'cover', overlay: 0.45 },
          { key: 'titre', kind: 'title', box: { x: 80, y: 760, w: 920, h: 400 }, style: { color: '#ffffff', weight: 800, maxSize: 72, minSize: 40, align: 'left', valign: 'bottom', lineHeight: 1.15 } },
          { key: 'signature', kind: 'signature', box: { x: 80, y: 1200, w: 920, h: 70 }, style: { color: '#ffffff', weight: 600, maxSize: 32, minSize: 22, align: 'left', lineHeight: 1.2 } },
        ],
      },
    },
  ];
}

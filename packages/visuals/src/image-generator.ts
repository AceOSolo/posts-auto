/**
 * Générateurs d'images (VIS-05) : interface commune, pour brancher Higgsfield au lancement
 * puis d'autres fournisseurs (section 8.3). Images fixes seulement, jamais de vidéo.
 *
 * Règles imposées à chaque demande : scène sans personne identifiable, sans texte, sans logo
 * ni marque réelle. Une image générée est toujours marquée comme telle (VIS-12).
 */
import { createCanvas } from '@napi-rs/canvas';

export interface ImageRequest {
  /** Sujet de la scène, décrit sans nom propre de personne ni de marque. */
  readonly subject: string;
  readonly width: number;
  readonly height: number;
}

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly provider: string;
  readonly model: string;
  /** Consigne réellement envoyée (gardée avec l'image : media_assets.prompt). */
  readonly prompt: string;
  /** Coût de l'image, s'il est connu (GEN-11). */
  readonly costUsd?: number;
}

export interface ImageGenerator {
  readonly provider: string;
  generate(request: ImageRequest): Promise<GeneratedImage>;
}

/** Contraintes ajoutées à toute consigne d'image (VIS-05). */
export const IMAGE_RULES =
  'Photographie réaliste, lumière naturelle. Aucune personne identifiable (pas de visage reconnaissable, personnes de dos ou floues seulement). Aucun texte, aucune lettre, aucun chiffre. Aucun logo ni marque réelle.';

export function imagePrompt(subject: string): string {
  const clean = subject.replace(/\s+/g, ' ').trim().slice(0, 400);
  return `${clean}. ${IMAGE_RULES}`;
}

/**
 * Générateur simulé (développement, tests) : une image abstraite, en dégradé, déterministe
 * pour un même sujet. Elle est traitée comme une image générée.
 */
export class FakeImageGenerator implements ImageGenerator {
  readonly provider = 'simulation';
  readonly requests: ImageRequest[] = [];

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    this.requests.push(request);
    let hash = 0;
    for (const ch of request.subject) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    const canvas = createCanvas(request.width, request.height);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, request.width, request.height);
    gradient.addColorStop(0, `hsl(${hue}, 30%, 50%)`);
    gradient.addColorStop(1, `hsl(${(hue + 40) % 360}, 30%, 28%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, request.width, request.height);
    for (let i = 0; i < 6; i += 1) {
      ctx.fillStyle = `hsla(${(hue + i * 30) % 360}, 60%, 70%, 0.18)`;
      ctx.beginPath();
      ctx.arc(((hash >> i) % request.width) + 0.5, ((hash >> (i + 3)) % request.height) + 0.5, request.width / (3 + i), 0, Math.PI * 2);
      ctx.fill();
    }
    return { bytes: new Uint8Array(await canvas.encode('png')), mime: 'image/png', provider: this.provider, model: 'simulation', prompt: imagePrompt(request.subject) };
  }
}

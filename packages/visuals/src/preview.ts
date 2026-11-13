/**
 * Aperçu d'un modèle (VIS-02) : textes typiques d'un post et photo neutre, pour juger la
 * mise en page avant que l'IA ne remplisse le modèle.
 */
import { createCanvas } from '@napi-rs/canvas';
import type { TemplateContent } from './template.ts';

let placeholder: Uint8Array | null = null;

/** Photo neutre : dégradé gris, quadrillage léger (aucun texte : le rendu le dirait). */
async function placeholderPhoto(): Promise<Uint8Array> {
  if (placeholder !== null) return placeholder;
  const canvas = createCanvas(1200, 900);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 1200, 900);
  gradient.addColorStop(0, '#9aa5b1');
  gradient.addColorStop(1, '#52606d');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1200, 900);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  for (let x = 0; x <= 1200; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 900);
    ctx.stroke();
  }
  for (let y = 0; y <= 900; y += 60) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(1200, y);
    ctx.stroke();
  }
  placeholder = new Uint8Array(await canvas.encode('png'));
  return placeholder;
}

export async function sampleContent(options: { readonly signature?: string; readonly logo?: Uint8Array | null } = {}): Promise<TemplateContent> {
  return {
    title: 'Évaluer les risques : 5 erreurs à éviter',
    subtitle: 'Marie Dupont, préventrice',
    bullets: ['Oublier les postes temporaires', 'Copier le document de l’an dernier', 'Ne pas associer les salariés'],
    signature: options.signature ?? 'Nom du compte',
    photo: await placeholderPhoto(),
    logo: options.logo ?? null,
  };
}

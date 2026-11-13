/**
 * Remplissage d'un modèle de visuel (VIS-03) : l'IA tire du post un titre et quelques
 * points courts, lisibles sur téléphone ; quand une photo est voulue (VIS-04), elle choisit
 * une photo de la médiathèque (VIS-08) ou décrit la scène d'une image à générer (VIS-05).
 *
 * Le post est une donnée (GEN-13). La consigne de « refaire le visuel » (VIS-13) vient d'un
 * membre de l'espace : elle est suivie, dans le respect des règles absolues.
 */
import { z } from 'zod';
import { asDocument, detectInjection } from './injection.ts';
import type { TextModel } from './model.ts';
import { VISUAL_SYSTEM } from './prompts.ts';
import type { UsageRecord } from './writer.ts';

export const VisualFillSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  bullets: z.array(z.string()),
  libraryPhotoId: z.string().describe('identifiant pris dans la liste de la médiathèque, ou chaîne vide'),
  imageSubject: z.string().describe('scène à générer, ou chaîne vide'),
  altText: z.string(),
  ignoredInstructions: z.array(z.string()),
});

export const VISUAL_LIMITS = { title: 70, subtitle: 60, bullet: 45, bullets: 4 } as const;

export interface LibraryPhoto {
  readonly id: string;
  readonly label: string | null;
  readonly folder: string | null;
  readonly tags: readonly string[];
}

export interface VisualFillInput {
  readonly postText: string;
  readonly accountName: string;
  readonly wantPhoto: boolean;
  /** Photos de la médiathèque proposées (les plus récentes d'abord). */
  readonly library: readonly LibraryPhoto[];
  /** « Refaire le visuel » : consigne et textes du visuel précédent. */
  readonly instruction?: string | null;
  readonly previous?: { readonly title: string; readonly bullets: readonly string[] } | null;
}

export interface VisualFill {
  readonly title: string;
  readonly subtitle: string | null;
  readonly bullets: readonly string[];
  readonly libraryPhotoId: string | null;
  readonly imageSubject: string | null;
  readonly altText: string;
  readonly suspiciousInstructions: readonly string[];
}

/** Coupe au dernier mot entier qui tient (sans « … » : le rendu signalera un texte trop long). */
function fit(text: string, max: number): string {
  const clean = text
    .replace(/\[(À|A) (COMPLÉTER|COMPLETER|VÉRIFIER|VERIFIER)[^\]]*\]/gi, '')
    .replace(/(^|\s)[#@][\p{L}\p{N}_]+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '');
  if ([...clean].length <= max) return clean;
  const cut = [...clean].slice(0, max + 1).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : [...clean].slice(0, max).join('')).replace(/[\s,;:–-]+$/, '');
}

export function renderVisualTask(input: VisualFillInput): string {
  const parts = [
    input.wantPhoto ? 'Une photo est demandée pour ce visuel.' : 'Ce visuel est sans photo : textes seulement.',
    asDocument('post', { id: 'post', compte: input.accountName }, input.postText),
  ];
  if (input.wantPhoto) {
    parts.push(
      input.library.length === 0
        ? 'La médiathèque de l’entreprise est vide : décris la scène à générer.'
        : `Photos de la médiathèque (identifiant : nom ; dossier ; mots-clés) :\n${input.library
            .map((p) => `- ${p.id} : ${p.label ?? 'sans nom'} ; ${p.folder ?? 'sans dossier'} ; ${p.tags.join(', ') || 'aucun mot-clé'}`)
            .join('\n')}`,
    );
  }
  if (input.previous) {
    parts.push(`Visuel précédent : « ${input.previous.title} »${input.previous.bullets.length > 0 ? ` ; points : ${input.previous.bullets.map((b) => `« ${b} »`).join(', ')}` : ''}.`);
  }
  if (input.instruction?.trim()) parts.push(`Consigne de l’équipe pour refaire le visuel : ${input.instruction.trim().slice(0, 1000)}`);
  return parts.join('\n\n');
}

export async function fillVisual(model: TextModel, input: VisualFillInput): Promise<{ fill: VisualFill; call: UsageRecord }> {
  const result = await model.call({
    purpose: 'visual',
    system: VISUAL_SYSTEM,
    context: `Compte : ${input.accountName}.`,
    task: renderVisualTask(input),
    schema: VisualFillSchema,
    maxTokens: 2000,
  });
  const v = result.value;
  const known = new Set(input.library.map((p) => p.id));
  const libraryPhotoId = input.wantPhoto && known.has(v.libraryPhotoId.trim()) ? v.libraryPhotoId.trim() : null;
  const subject = v.imageSubject.replace(/\s+/g, ' ').trim();
  const bullets = v.bullets.map((b) => fit(b, VISUAL_LIMITS.bullet)).filter((b) => b !== '');
  const title = fit(v.title, VISUAL_LIMITS.title);
  return {
    call: { purpose: 'visual', provider: result.provider, model: result.model, usage: result.usage },
    fill: {
      title: title === '' ? fit(input.postText.split('\n')[0] ?? '', VISUAL_LIMITS.title) : title,
      subtitle: fit(v.subtitle, VISUAL_LIMITS.subtitle) || null,
      // Moins de trois points ne font pas une liste.
      bullets: bullets.length >= 3 ? bullets.slice(0, VISUAL_LIMITS.bullets) : [],
      libraryPhotoId,
      imageSubject: input.wantPhoto && libraryPhotoId === null && subject !== '' ? subject.slice(0, 400) : null,
      altText: v.altText.replace(/\s+/g, ' ').trim().slice(0, 300),
      suspiciousInstructions: [...new Set([...detectInjection(input.postText), ...v.ignoredInstructions])],
    },
  };
}

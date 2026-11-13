/**
 * Contrôle d'une image générée (VIS-11), avant qu'elle illustre un post : personne
 * identifiable, texte, logo ou marque (les règles de VIS-05), défauts de génération (mains,
 * visages), contenu choquant. L'IA regarde l'image et répond par oui ou non à chaque point ;
 * le code décide.
 */
import { z } from 'zod';
import type { ModelImage, TextModel } from './model.ts';
import { INSPECTOR_SYSTEM } from './prompts.ts';
import type { UsageRecord } from './writer.ts';

export const ImageInspectionSchema = z.object({
  identifiablePerson: z.boolean(),
  visibleText: z.boolean(),
  logoOrBrand: z.boolean(),
  defects: z.boolean(),
  shocking: z.boolean(),
  description: z.string(),
});

const PROBLEMS = {
  identifiablePerson: 'personne identifiable',
  visibleText: 'texte ou chiffres visibles',
  logoOrBrand: 'logo ou marque',
  defects: 'défaut de génération (mains, visage, objet déformé)',
  shocking: 'contenu choquant',
} as const;

export interface ImageInspection {
  /** Problèmes relevés, en clair ; vide si l'image convient. */
  readonly problems: readonly string[];
  /** Ce que montre l'image (texte alternatif). */
  readonly description: string;
}

export async function inspectImage(model: TextModel, image: ModelImage): Promise<{ inspection: ImageInspection; call: UsageRecord }> {
  const result = await model.call({
    purpose: 'visual',
    system: INSPECTOR_SYSTEM,
    context: 'Contrôle d’une image générée pour un post LinkedIn.',
    task: 'Examine l’image jointe et réponds au format demandé.',
    images: [image],
    schema: ImageInspectionSchema,
    maxTokens: 1000,
  });
  const v = result.value;
  return {
    call: { purpose: 'visual', provider: result.provider, model: result.model, usage: result.usage },
    inspection: {
      problems: (Object.keys(PROBLEMS) as (keyof typeof PROBLEMS)[]).filter((key) => v[key]).map((key) => PROBLEMS[key]),
      description: v.description.replace(/\s+/g, ' ').trim().slice(0, 300),
    },
  };
}

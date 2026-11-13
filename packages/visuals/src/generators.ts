import { HiggsfieldImageGenerator } from './higgsfield.ts';
import { FakeImageGenerator, type ImageGenerator } from './image-generator.ts';

/**
 * Générateur d'images selon l'environnement (IMAGE_MODE) :
 * - « higgsfield » avec HIGGSFIELD_API_KEY_ID et HIGGSFIELD_API_KEY_SECRET (HIGGSFIELD_MODEL
 *   pour changer de modèle, HIGGSFIELD_COST_USD pour le coût d'une image) ;
 * - « fake » : générateur simulé (développement, démonstration) ;
 * - absent ou « none » : pas d'image générée ; les visuels prennent une photo de la
 *   médiathèque ou deviennent des visuels texte.
 */
export function imageGeneratorFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ImageGenerator | null {
  if (env['IMAGE_MODE'] === 'fake') return new FakeImageGenerator();
  const keyId = env['HIGGSFIELD_API_KEY_ID'];
  const keySecret = env['HIGGSFIELD_API_KEY_SECRET'];
  if (env['IMAGE_MODE'] === 'higgsfield' && keyId && keySecret) {
    const cost = Number.parseFloat(env['HIGGSFIELD_COST_USD'] ?? '');
    return new HiggsfieldImageGenerator({
      keyId,
      keySecret,
      ...(env['HIGGSFIELD_MODEL'] && { model: env['HIGGSFIELD_MODEL'] }),
      ...(Number.isFinite(cost) && cost >= 0 && { costUsd: cost }),
    });
  }
  return null;
}

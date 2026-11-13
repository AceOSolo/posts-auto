import { describe, expect, it } from 'vitest';
import { FakeModel } from './fake-model.ts';
import { inspectImage } from './image-inspection.ts';
import { INSPECTOR_SYSTEM } from './prompts.ts';

const image = { mime: 'image/jpeg' as const, data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) };
const answer = (overrides: Record<string, unknown> = {}) => ({
  identifiablePerson: false,
  visibleText: false,
  logoOrBrand: false,
  defects: false,
  shocking: false,
  description: '  Un atelier   lumineux, vu de loin. ',
  ...overrides,
});

describe('contrôle d’une image générée (VIS-11)', () => {
  it('joint l’image à l’appel et relève une image conforme', async () => {
    const model = new FakeModel(() => answer());
    const { inspection, call } = await inspectImage(model, image);
    expect(inspection).toEqual({ problems: [], description: 'Un atelier lumineux, vu de loin.' });
    expect(call.purpose).toBe('visual');
    expect(model.calls[0]?.images).toEqual([image]);
    expect(model.calls[0]?.system).toBe(INSPECTOR_SYSTEM);
  });

  it('nomme chaque problème relevé', async () => {
    const model = new FakeModel(() => answer({ identifiablePerson: true, visibleText: true, logoOrBrand: true, defects: true, shocking: true }));
    const { inspection } = await inspectImage(model, image);
    expect(inspection.problems).toEqual([
      'personne identifiable',
      'texte ou chiffres visibles',
      'logo ou marque',
      'défaut de génération (mains, visage, objet déformé)',
      'contenu choquant',
    ]);
  });

  it('le modèle simulé accepte les images simulées', async () => {
    const { inspection } = await inspectImage(new FakeModel(), image);
    expect(inspection.problems).toEqual([]);
  });
});

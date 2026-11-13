import { describe, expect, it } from 'vitest';
import { galleryTemplates } from './gallery.ts';
import { type TemplateCandidate, photoBox, photoTurns, rankTemplates } from './selection.ts';

describe('alternance photo / texte (VIS-04)', () => {
  it('alterne un sur deux, en commençant par une photo', () => {
    expect(photoTurns([], 6, 0.5)).toEqual([true, false, true, false, true, false]);
  });

  it('tient compte des derniers visuels du compte', () => {
    expect(photoTurns([true], 3, 0.5)).toEqual([false, true, false]);
    expect(photoTurns([false, false], 2, 0.5)).toEqual([true, true]);
  });

  it('respecte les extrêmes et une part intermédiaire', () => {
    expect(photoTurns([true, false], 4, 0)).toEqual([false, false, false, false]);
    expect(photoTurns([], 4, 1)).toEqual([true, true, true, true]);
    const turns = photoTurns([], 10, 0.3);
    expect(turns.filter(Boolean)).toHaveLength(3);
  });
});

describe('choix du modèle (VIS-01)', () => {
  const gallery = galleryTemplates();
  const def = (key: string) => (gallery.find((t) => t.key === key) as (typeof gallery)[number]).definition;
  const candidate = (id: string, key: string, accountId: string | null = null, day = 1): TemplateCandidate => ({ id, accountId, definition: def(key), createdAt: new Date(`2026-11-0${day}T00:00:00Z`) });
  const workspace = [candidate('points', 'titre-points', null, 1), candidate('citation', 'citation', null, 2), candidate('photo', 'photo-titre', null, 3), candidate('pleine', 'photo-pleine', null, 4)];
  const none = new Map<string, number>();

  it('sépare les modèles avec et sans photo', () => {
    expect(rankTemplates(workspace, { accountId: 'a', withPhoto: true, bullets: 3, uses: none }).map((t) => t.id)).toEqual(['photo', 'pleine']);
    expect(rankTemplates(workspace, { accountId: 'a', withPhoto: false, bullets: 3, uses: none }).map((t) => t.id)).toEqual(['points', 'citation']);
  });

  it('écarte un modèle à liste de points quand il n’y a pas de points', () => {
    expect(rankTemplates(workspace, { accountId: 'a', withPhoto: false, bullets: 0, uses: none }).map((t) => t.id)).toEqual(['citation']);
    const onlyBullets = [candidate('points', 'titre-points')];
    expect(rankTemplates(onlyBullets, { accountId: 'a', withPhoto: false, bullets: 0, uses: none }).map((t) => t.id)).toEqual(['points']);
  });

  it('varie : le modèle le moins utilisé par le compte passe devant', () => {
    const uses = new Map([['photo', 3]]);
    expect(rankTemplates(workspace, { accountId: 'a', withPhoto: true, bullets: 0, uses }).map((t) => t.id)).toEqual(['pleine', 'photo']);
  });

  it('prend les modèles du compte quand il en a, jamais ceux d’un autre compte', () => {
    const all = [...workspace, candidate('mien', 'photo-titre', 'a', 5), candidate('autre', 'photo-titre', 'b', 6)];
    expect(rankTemplates(all, { accountId: 'a', withPhoto: true, bullets: 0, uses: none }).map((t) => t.id)).toEqual(['mien']);
    expect(rankTemplates(all, { accountId: 'c', withPhoto: true, bullets: 0, uses: none }).map((t) => t.id)).toEqual(['photo', 'pleine']);
    // Le compte n'a de modèle qu'avec photo : pour un visuel texte, ceux de l'espace.
    expect(rankTemplates(all, { accountId: 'a', withPhoto: false, bullets: 3, uses: none }).map((t) => t.id)).toEqual(['points', 'citation']);
  });

  it('donne la taille de la zone photo', () => {
    expect(photoBox(def('photo-titre'))).toEqual({ width: 1080, height: 640 });
    expect(photoBox(def('citation'))).toBeNull();
  });
});

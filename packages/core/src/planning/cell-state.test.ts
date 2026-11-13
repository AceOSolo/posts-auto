import { describe, expect, it } from 'vitest';
import { cellStatus } from './cell-state.ts';

describe('état d’un sujet du planning (PLA-02)', () => {
  it.each([
    [[], 'planned'],
    [['a_valider'], 'drafted'],
    [['remplace', 'modif'], 'drafted'],
    [['remplace', 'valide'], 'validated'],
    [['en_publication'], 'validated'],
    [['publie'], 'published'],
    [['remplace'], 'planned'],
  ] as const)('posts %j → %s', (statuses, state) => {
    expect(cellStatus(false, statuses).state).toBe(state);
  });

  it('« mis de côté » l’emporte : c’est une décision de l’équipe', () => {
    expect(cellStatus(true, ['a_valider'])).toEqual({ state: 'set_aside', needsAttention: false });
  });

  it('un post abandonné ou en erreur signale la case (RÈG-10)', () => {
    expect(cellStatus(false, ['abandonne'])).toEqual({ state: 'planned', needsAttention: true });
    expect(cellStatus(false, ['erreur'])).toEqual({ state: 'drafted', needsAttention: true });
  });
});

import { describe, expect, it } from 'vitest';
import { BLOCKING_MARKER_SAMPLES } from '../testing.ts';
import { findBlockingMarkers, hasBlockingMarkers } from './markers.ts';

describe('marqueurs bloquants (VAL-03)', () => {
  it.each(BLOCKING_MARKER_SAMPLES)('%j → %s', (text, blocking) => {
    expect(hasBlockingMarkers(text)).toBe(blocking);
  });

  it('localise chaque marqueur pour le surligner', () => {
    const text = 'Le [À COMPLÉTER : date] à [À VÉRIFIER] heures.';
    expect(findBlockingMarkers(text)).toEqual([
      { start: 3, end: 23, text: '[À COMPLÉTER : date]' },
      { start: 26, end: 38, text: '[À VÉRIFIER]' },
    ]);
  });

  it('s’arrête en fin de ligne si le crochet n’est jamais fermé', () => {
    expect(findBlockingMarkers('[À COMPLÉTER : date\nsuite')).toEqual([
      { start: 0, end: 19, text: '[À COMPLÉTER : date' },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { BLOCKING_MARKER_SAMPLES } from '../testing.ts';
import { fillMarkers, findBlockingMarkers, hasBlockingMarkers, markerQuestions } from './markers.ts';

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

  it('pose une question par passage à compléter', () => {
    expect(markerQuestions('Le [À COMPLÉTER : date] à [a completer: lieu].').map((q) => q.label)).toEqual(['date', 'lieu']);
  });

  it('ne pose aucune question si un passage demande une relecture', () => {
    expect(markerQuestions('Le [À COMPLÉTER : date], [À VÉRIFIER] 30 %.')).toEqual([]);
    expect(markerQuestions('Le [à compléter].')).toEqual([]);
    expect(markerQuestions('Rien à compléter.')).toEqual([]);
  });

  it('remplace chaque passage par sa réponse, et garde ceux restés sans réponse', () => {
    const text = 'Le [À COMPLÉTER : date] à [À COMPLÉTER : lieu].';
    expect(fillMarkers(text, ['11 décembre', ' Lyon '])).toBe('Le 11 décembre à Lyon.');
    expect(fillMarkers(text, ['11 décembre', ''])).toBe('Le 11 décembre à [À COMPLÉTER : lieu].');
    expect(fillMarkers(text, [])).toBe(text);
  });
});

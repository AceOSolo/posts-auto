import { describe, expect, it } from 'vitest';
import { departureSentence } from './departure.ts';

const TZ = 'Europe/Paris';
// Lundi 16 novembre 2026, 10h00 à Paris.
const NOW = new Date('2026-11-16T09:00:00Z');
const at = (iso: string) => new Date(iso);

describe('phrase de départ (VAL-04)', () => {
  it('post validé pour demain midi', () => {
    expect(departureSentence({ status: 'valide', scheduledAt: at('2026-11-17T11:00:00Z') }, NOW, TZ)).toBe('Part demain à 12h');
  });

  it('heure avec minutes, aujourd’hui', () => {
    expect(departureSentence({ status: 'valide', scheduledAt: at('2026-11-16T15:30:00Z') }, NOW, TZ)).toBe('Part aujourd’hui à 16h30');
  });

  it('jour de la semaine dans les 6 jours, date au-delà', () => {
    expect(departureSentence({ status: 'a_valider', scheduledAt: at('2026-11-19T08:00:00Z') }, NOW, TZ)).toBe('Partira jeudi à 9h si validé');
    expect(departureSentence({ status: 'a_valider', scheduledAt: at('2026-11-30T11:00:00Z') }, NOW, TZ)).toBe(
      'Partira lundi 30 novembre à 12h si validé',
    );
  });

  it('post replanifié faute de validation', () => {
    const sentence = departureSentence(
      { status: 'a_valider', scheduledAt: at('2026-11-17T11:00:00Z'), originalScheduledAt: at('2026-11-13T11:00:00Z'), rescheduleCount: 1 },
      NOW,
      TZ,
    );
    expect(sentence).toBe('Replanifié : créneau de vendredi 12h manqué. Partira demain à 12h si validé');
  });

  it('créneau passé sans validation', () => {
    expect(departureSentence({ status: 'a_valider', scheduledAt: at('2026-11-16T08:00:00Z') }, NOW, TZ)).toBe(
      'Créneau aujourd’hui à 9h passé : partira dès validation, sinon sera replanifié',
    );
  });

  it('validé et dû : part dans quelques minutes', () => {
    expect(departureSentence({ status: 'valide', scheduledAt: at('2026-11-16T08:59:00Z') }, NOW, TZ)).toBe('Part dans quelques minutes');
  });

  it.each([
    ['publie', 'Publié hier à 12h'],
    ['en_publication', 'Envoi à LinkedIn en cours'],
    ['erreur', 'Erreur de publication : voir le détail'],
    ['modif', 'Modification demandée : nouvelle version en préparation'],
    ['refuse', 'Refusé : un autre sujet va être proposé'],
    ['remplace', 'Remplacé par une nouvelle version'],
    ['abandonne', 'Sorti du circuit'],
    ['brouillon', 'En préparation'],
  ] as const)('%s', (status, sentence) => {
    expect(
      departureSentence({ status, scheduledAt: at('2026-11-15T11:00:00Z'), publishedAt: at('2026-11-15T11:00:00Z') }, NOW, TZ),
    ).toBe(sentence);
  });
});

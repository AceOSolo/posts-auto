import { describe, expect, it } from 'vitest';
import { lastCronOccurrence, parseCron } from './cron.ts';

const schedule = (expression: string) => {
  const parsed = parseCron(expression);
  if (parsed === null) throw new Error(`expression invalide : ${expression}`);
  return parsed;
};

describe('programmation de la rédaction (GEN-01)', () => {
  it('par défaut le lundi à 7h30, heure de Paris', () => {
    const monday = schedule('30 7 * * 1');
    // Vendredi 13 novembre 2026, 15h : dernière échéance lundi 9 novembre 7h30 (6h30 UTC).
    expect(lastCronOccurrence(monday, new Date('2026-11-13T14:00:00Z'), 'Europe/Paris')).toEqual(new Date('2026-11-09T06:30:00Z'));
    // Lundi 16 novembre, 7h29 : pas encore ; 7h30 : c'est l'heure.
    expect(lastCronOccurrence(monday, new Date('2026-11-16T06:29:00Z'), 'Europe/Paris')).toEqual(new Date('2026-11-09T06:30:00Z'));
    expect(lastCronOccurrence(monday, new Date('2026-11-16T06:30:00Z'), 'Europe/Paris')).toEqual(new Date('2026-11-16T06:30:00Z'));
  });

  it('reste à 7h30 heure locale de part et d’autre du changement d’heure', () => {
    const monday = schedule('30 7 * * 1');
    expect(lastCronOccurrence(monday, new Date('2026-03-30T12:00:00Z'), 'Europe/Paris')).toEqual(new Date('2026-03-30T05:30:00Z'));
    expect(lastCronOccurrence(monday, new Date('2026-03-24T12:00:00Z'), 'Europe/Paris')).toEqual(new Date('2026-03-23T06:30:00Z'));
  });

  it('listes, intervalles, pas et dimanche noté 0 ou 7', () => {
    expect(schedule('0 8,14 * * 1-5').hours).toEqual(new Set([8, 14]));
    expect(schedule('*/15 * * * *').minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(schedule('0 9 * * 0').daysOfWeek).toEqual(new Set([7]));
    expect(schedule('0 9 * * 7').daysOfWeek).toEqual(new Set([7]));
    expect(schedule('0 9 1 * *').daysOfMonth).toEqual(new Set([1]));
  });

  it('jour du mois et jour de la semaine restreints : l’un ou l’autre suffit (règle cron)', () => {
    const either = schedule('0 9 1 * 3');
    // Mercredi 18 novembre 2026, 10h.
    expect(lastCronOccurrence(either, new Date('2026-11-18T09:00:00Z'), 'Europe/Paris')).toEqual(new Date('2026-11-18T08:00:00Z'));
  });

  it.each(['', '30 7 * *', '60 7 * * 1', '30 24 * * 1', '30 7 * * 8', 'a b c d e', '5-1 * * * *', '*/0 * * * *'])('« %s » est refusée', (expression) => {
    expect(parseCron(expression)).toBeNull();
  });

  it('aucune échéance dans la période regardée', () => {
    expect(lastCronOccurrence(schedule('0 9 29 2 *'), new Date('2026-11-13T12:00:00Z'), 'Europe/Paris', 8)).toBeNull();
  });
});

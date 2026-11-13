import { describe, expect, it } from 'vitest';
import { easterSunday, holidaysOf, isHoliday } from './holidays.ts';

describe('date de Pâques', () => {
  it.each([
    [2024, 3, 31],
    [2025, 4, 20],
    [2026, 4, 5],
    [2027, 3, 28],
    [2028, 4, 16],
    [2038, 4, 25], // la plus tardive possible
    [2285, 3, 22], // la plus précoce possible
  ])('%i : %i/%i', (year, month, day) => {
    expect(easterSunday(year)).toEqual({ month, day });
  });
});

describe('jours fériés français', () => {
  it('liste les 11 jours fériés de 2026 aux bonnes dates', () => {
    expect(holidaysOf('FR', 2026).map((h) => h.date)).toEqual([
      '2026-01-01',
      '2026-04-06', // lundi de Pâques
      '2026-05-01',
      '2026-05-08',
      '2026-05-14', // Ascension
      '2026-05-25', // lundi de Pentecôte
      '2026-07-14',
      '2026-08-15',
      '2026-11-01',
      '2026-11-11',
      '2026-12-25',
    ]);
  });

  it('calcule les fêtes mobiles de 2027', () => {
    expect(isHoliday('FR', '2027-03-29')).toBe(true); // lundi de Pâques
    expect(isHoliday('FR', '2027-05-06')).toBe(true); // Ascension
    expect(isHoliday('FR', '2027-05-17')).toBe(true); // lundi de Pentecôte
    expect(isHoliday('FR', '2027-05-18')).toBe(false);
  });

  it('ajoute le Vendredi saint et la Saint-Étienne en Alsace-Moselle', () => {
    expect(isHoliday('FR-alsace-moselle', '2026-04-03')).toBe(true);
    expect(isHoliday('FR-alsace-moselle', '2026-12-26')).toBe(true);
    expect(isHoliday('FR', '2026-04-03')).toBe(false);
  });

  it('n’exclut aucun jour avec le calendrier « none »', () => {
    expect(isHoliday('none', '2026-12-25')).toBe(false);
  });
});

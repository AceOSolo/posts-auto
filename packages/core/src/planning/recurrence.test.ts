import { describe, expect, it } from 'vitest';
import { occurrences } from './recurrence.ts';

describe('rendez-vous récurrents (EDI-08)', () => {
  it('mensuel : même jour chaque mois, jusqu’à la date de fin', () => {
    expect(occurrences('2026-09-15', 'monthly', '2027-01-31', '2026-11-01', '2027-03-01')).toEqual(['2026-11-15', '2026-12-15', '2027-01-15']);
  });

  it('mensuel le 31 : dernier jour des mois plus courts', () => {
    expect(occurrences('2027-01-31', 'monthly', null, '2027-01-01', '2027-04-30')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });

  it('annuel : journée mondiale à date fixe ; 29 février → 28 les autres années', () => {
    expect(occurrences('2025-04-28', 'yearly', null, '2026-01-01', '2028-12-31')).toEqual(['2026-04-28', '2027-04-28', '2028-04-28']);
    expect(occurrences('2028-02-29', 'yearly', null, '2028-01-01', '2030-12-31')).toEqual(['2028-02-29', '2029-02-28', '2030-02-28']);
  });

  it('hebdomadaire, borné en nombre', () => {
    expect(occurrences('2026-11-03', 'weekly', null, '2026-11-01', '2026-11-30')).toEqual(['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24']);
    expect(occurrences('2026-11-03', 'weekly', null, '2026-11-01', '2030-11-30', 5)).toHaveLength(5);
  });

  it('sans récurrence : l’événement seul, s’il tombe dans la période', () => {
    expect(occurrences('2026-12-08', 'none', null, '2026-11-01', '2026-12-31')).toEqual(['2026-12-08']);
    expect(occurrences('2026-12-08', 'none', null, '2027-01-01', '2027-12-31')).toEqual([]);
    expect(occurrences('pas une date', 'monthly', null, '2026-01-01', '2026-12-31')).toEqual([]);
  });
});

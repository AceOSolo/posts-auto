import { describe, expect, it } from 'vitest';
import { WORLD_DAYS, nextWorldDayDate, normalizeLabel, sectorsOf, upcomingWorldDays } from './world-days.ts';

describe('catalogue des journées (PLA-10)', () => {
  it('chaque journée a un identifiant et un titre uniques, une vraie date et une source officielle', () => {
    expect(new Set(WORLD_DAYS.map((d) => d.id)).size).toBe(WORLD_DAYS.length);
    expect(new Set(WORLD_DAYS.map((d) => normalizeLabel(d.title))).size).toBe(WORLD_DAYS.length);
    for (const day of WORLD_DAYS) {
      const iso = `2027-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
      expect(new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso), day.id).toBe(true);
      expect(day.source, day.id).toMatch(/^https:\/\//);
    }
  });

  it('garde les dates vérifiées des journées clés', () => {
    const at = (id: string) => WORLD_DAYS.find((d) => d.id === id);
    expect(at('securite-sante-travail')).toMatchObject({ month: 4, day: 28 });
    expect(at('sante-mentale')).toMatchObject({ month: 10, day: 10 });
    expect(at('aidants')).toMatchObject({ month: 10, day: 6, scope: 'nationale' });
    expect(at('pme')).toMatchObject({ month: 6, day: 27 });
  });
});

describe('secteur du client', () => {
  it('reconnaît un secteur saisi librement, sans tenir compte des accents ni de la casse', () => {
    expect(sectorsOf('Prévention et SÉCURITÉ au travail')).toContain('prevention');
    expect(sectorsOf('BTP')).toEqual(['btp-industrie']);
    expect(sectorsOf('Éditeur de logiciels')).toEqual(['numerique']);
    expect(sectorsOf('Cabinet RH')).toEqual(['rh']);
  });

  it('ne confond pas un mot qui en contient un autre', () => {
    expect(sectorsOf('Vallée du Rhône')).toEqual([]);
    expect(sectorsOf('Bureau d’études techniques')).toEqual([]);
    expect(sectorsOf('Beaux-arts')).toEqual([]);
  });

  it('sans secteur : rien de reconnu', () => {
    expect(sectorsOf(null)).toEqual([]);
    expect(sectorsOf('Conseil')).toEqual([]);
  });
});

describe('prochaine date', () => {
  it('garde le jour même et passe à l’année suivante une fois la date dépassée', () => {
    expect(nextWorldDayDate({ month: 4, day: 28 }, '2026-04-28')).toBe('2026-04-28');
    expect(nextWorldDayDate({ month: 4, day: 28 }, '2026-04-29')).toBe('2027-04-28');
    expect(nextWorldDayDate({ month: 1, day: 24 }, '2026-12-31')).toBe('2027-01-24');
  });
});

describe('suggestions', () => {
  it('propose les journées du secteur et celles de toute entreprise, par date', () => {
    const days = upcomingWorldDays('Santé', '2026-11-23', { limit: 10 });
    expect(days.map((d) => d.id)).toEqual(['sida', 'personnes-handicapees', 'droits-femmes']);
    expect(days[0]).toMatchObject({ date: '2026-12-01', matchesSector: true });
    expect(days[1]).toMatchObject({ date: '2026-12-03', matchesSector: false });
  });

  it('sans secteur reconnu : seulement les journées de toute entreprise', () => {
    const days = upcomingWorldDays(null, '2026-11-23', { limit: 10 });
    expect(days.every((d) => d.sectors.length === 0)).toBe(true);
    expect(days.map((d) => d.id)).toEqual(['personnes-handicapees', 'droits-femmes']);
  });

  it('respecte l’horizon et la limite, et écarte les journées déjà planifiées', () => {
    expect(upcomingWorldDays('Santé', '2026-11-23', { horizonDays: 8 }).map((d) => d.id)).toEqual(['sida']);
    expect(upcomingWorldDays('Santé', '2026-11-23', { limit: 1 })).toHaveLength(1);
    const exclude = new Set([normalizeLabel('JOURNÉE MONDIALE DE LUTTE CONTRE LE SIDA')]);
    expect(upcomingWorldDays('Santé', '2026-11-23', { excludeTitles: exclude }).map((d) => d.id)).not.toContain('sida');
  });
});

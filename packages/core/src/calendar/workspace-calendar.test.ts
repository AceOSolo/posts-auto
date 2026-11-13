import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_CALENDAR as cal,
  type WorkspaceCalendar,
  allowedSlots,
  atLocal,
  isWithinAllowedHours,
  isoWeekBounds,
  localDate,
  minutesOfDay,
  sameIsoWeek,
  usualSlotsInWeek,
} from './workspace-calendar.js';

const utc = (iso: string) => new Date(iso);
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('indépendance vis-à-vis du fuseau de la machine', () => {
  it('les tests tournent volontairement dans un autre fuseau que celui de l’espace', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
  });
});

describe('heures locales', () => {
  it('convertit une heure locale de Paris en instant UTC, été comme hiver (REC-16)', () => {
    // 25 octobre 2026 : passage à l'heure d'hiver.
    expect(atLocal('2026-10-20', '12:00', cal)?.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(atLocal('2026-10-27', '12:00', cal)?.toISOString()).toBe('2026-10-27T11:00:00.000Z');
  });

  it('renvoie null pour une heure qui n’existe pas (passage à l’heure d’été)', () => {
    expect(atLocal('2027-03-28', '02:30', cal)).toBeNull();
    expect(atLocal('2027-03-28', '03:00', cal)?.toISOString()).toBe('2027-03-28T01:00:00.000Z');
  });

  it('refuse une heure mal formée', () => {
    expect(() => minutesOfDay('9:00')).toThrow();
    expect(() => minutesOfDay('24:00')).toThrow();
  });

  it('donne la date civile locale, pas la date UTC', () => {
    // 23h30 UTC un lundi = 0h30 mardi à Paris en hiver.
    expect(localDate(utc('2026-11-16T23:30:00Z'), cal)).toBe('2026-11-17');
  });
});

describe('plages autorisées (RÈG-02)', () => {
  it.each([
    ['mardi 12h00', '2026-11-17T11:00:00Z', true],
    ['mardi 7h59', '2026-11-17T06:59:00Z', false],
    ['mardi 8h00 (borne incluse)', '2026-11-17T07:00:00Z', true],
    ['mardi 18h00 (borne incluse)', '2026-11-17T17:00:00Z', true],
    ['mardi 18h00 et 30 s', '2026-11-17T17:00:30Z', false],
    ['samedi 12h00', '2026-11-21T11:00:00Z', false],
    ['mercredi 11 novembre (férié) 12h00', '2026-11-11T11:00:00Z', false],
  ])('%s → %s', (_label, instant, expected) => {
    expect(isWithinAllowedHours(utc(instant), cal)).toBe(expected);
  });
});

describe('semaine ISO', () => {
  it('va du lundi 0h00 au lundi suivant 0h00, heure de Paris', () => {
    const { start, end } = isoWeekBounds(utc('2026-11-18T10:00:00Z'), cal);
    expect(start.toISOString()).toBe('2026-11-15T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-22T23:00:00.000Z');
  });

  it('dure 169 heures la semaine du passage à l’heure d’hiver', () => {
    const { start, end } = isoWeekBounds(utc('2026-10-21T10:00:00Z'), cal);
    expect(start.toISOString()).toBe('2026-10-18T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(169);
  });

  it('sépare dimanche 23h30 et lundi 0h30 locaux', () => {
    expect(sameIsoWeek(utc('2026-11-22T22:30:00Z'), utc('2026-11-22T23:30:00Z'), cal)).toBe(false);
  });
});

describe('grille des créneaux candidats', () => {
  it('produit les créneaux de 30 en 30 min dans les plages, en sautant la nuit et le week-end', () => {
    // Du vendredi 20 novembre 17h00 au lundi 23 novembre 9h00 (heure de Paris).
    const slots = [...allowedSlots(utc('2026-11-20T16:00:00Z'), utc('2026-11-23T08:00:00Z'), cal)];
    expect(iso(slots)).toEqual([
      '2026-11-20T16:00:00.000Z', // ven. 17h00
      '2026-11-20T16:30:00.000Z', // ven. 17h30
      '2026-11-20T17:00:00.000Z', // ven. 18h00
      '2026-11-23T07:00:00.000Z', // lun. 8h00
      '2026-11-23T07:30:00.000Z', // lun. 8h30
    ]);
  });

  it('compte 21 créneaux par jour ouvré (8h00 → 18h00 par pas de 30 min)', () => {
    const slots = [...allowedSlots(utc('2026-11-16T00:00:00Z'), utc('2026-11-17T00:00:00Z'), cal)];
    expect(slots).toHaveLength(21);
  });

  it('saute les jours fériés', () => {
    const slots = [...allowedSlots(utc('2026-11-10T22:00:00Z'), utc('2026-11-12T07:01:00Z'), cal)];
    expect(iso(slots)).toEqual(['2026-11-12T07:00:00.000Z']); // le 11 novembre est sauté
  });

  it('saute les heures inexistantes au passage à l’heure d’été', () => {
    const nightOwl: WorkspaceCalendar = { ...cal, allowedHours: { 7: [{ start: '02:00', end: '03:00' }] }, holidays: 'none' };
    const slots = [...allowedSlots(utc('2027-03-27T00:00:00Z'), utc('2027-03-29T00:00:00Z'), nightOwl)];
    expect(iso(slots)).toEqual(['2027-03-28T01:00:00.000Z']); // seul 3h00 existe
  });

  it('ne produit pas deux fois un créneau quand des plages se chevauchent', () => {
    const overlapping: WorkspaceCalendar = {
      ...cal,
      allowedHours: { 2: [{ start: '09:00', end: '10:00' }, { start: '09:30', end: '10:30' }] },
    };
    const slots = [...allowedSlots(utc('2026-11-17T00:00:00Z'), utc('2026-11-18T00:00:00Z'), overlapping)];
    expect(slots.map((d) => d.toISOString().slice(11, 16))).toEqual(['08:00', '08:30', '09:00', '09:30']);
  });

  it('ne produit rien sur un intervalle vide', () => {
    expect([...allowedSlots(utc('2026-11-17T12:00:00Z'), utc('2026-11-17T12:00:00Z'), cal)]).toEqual([]);
  });
});

describe('créneaux habituels d’un compte', () => {
  it('place « mardi 12h00 » à 12h00 locales de part et d’autre du changement d’heure', () => {
    const slots = [{ weekday: 2, time: '12:00' }] as const;
    expect(iso(usualSlotsInWeek(utc('2026-10-22T10:00:00Z'), slots, cal))).toEqual(['2026-10-20T10:00:00.000Z']);
    expect(iso(usualSlotsInWeek(utc('2026-10-29T10:00:00Z'), slots, cal))).toEqual(['2026-10-27T11:00:00.000Z']);
  });

  it('trie les créneaux de la semaine', () => {
    const slots = [
      { weekday: 4, time: '09:00' },
      { weekday: 1, time: '17:30' },
    ] as const;
    expect(iso(usualSlotsInWeek(utc('2026-11-18T10:00:00Z'), slots, cal))).toEqual([
      '2026-11-16T16:30:00.000Z',
      '2026-11-19T08:00:00.000Z',
    ]);
  });
});

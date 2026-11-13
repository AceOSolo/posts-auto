import { describe, expect, it } from 'vitest';
import { type WorkspaceSettingsRow, calendarOf, slotRulesOf, weekStartOf } from './workspace-settings.ts';

const row = (overrides: Partial<WorkspaceSettingsRow> = {}): WorkspaceSettingsRow => ({
  timezone: 'Europe/Paris',
  allowed_hours: { '1': [{ start: '08:00', end: '18:00' }], '5': [{ start: '09:00', end: '12:00' }] },
  holidays_calendar: 'FR',
  slot_step_minutes: 30,
  max_posts_per_account_per_day: 2,
  min_gap_minutes: 30,
  max_posts_per_slot: 2,
  ...overrides,
});

describe('réglages d’un espace', () => {
  it('convertit les colonnes en calendrier et en règles de créneaux', () => {
    expect(calendarOf(row())).toEqual({
      timeZone: 'Europe/Paris',
      allowedHours: { 1: [{ start: '08:00', end: '18:00' }], 5: [{ start: '09:00', end: '12:00' }] },
      holidays: 'FR',
      slotStepMinutes: 30,
    });
    expect(slotRulesOf(row())).toEqual({ maxPostsPerAccountPerDay: 2, minGapMinutesInWorkspace: 30, maxWorkspacePostsPerSlot: 2 });
  });

  it.each([
    [{ allowed_hours: [] }, /objet attendu/],
    [{ allowed_hours: { '8': [] } }, /jour « 8 »/],
    [{ allowed_hours: { '1': 'tout le temps' } }, /liste de plages/],
    [{ allowed_hours: { '1': [{ start: '08:00' }] } }, /plage invalide/],
    [{ allowed_hours: { '1': [{ start: '18:00', end: '08:00' }] } }, /après/],
    [{ allowed_hours: { '1': [{ start: '8h', end: '18:00' }] } }, /Heure invalide/],
    [{ holidays_calendar: 'XX' }, /jours fériés inconnu/],
    [{ timezone: 'Europe/Pariss' }, /Fuseau horaire inconnu/],
  ])('signale une configuration invalide : %j', (overrides, message) => {
    expect(() => calendarOf(row(overrides as Partial<WorkspaceSettingsRow>))).toThrow(message);
  });

  it('calcule le lundi de la semaine dans le fuseau de l’espace', () => {
    // Dimanche 22/11/2026 23h30 UTC = lundi 23 à 0h30 à Paris : semaine du 23.
    expect(weekStartOf(new Date('2026-11-22T23:30:00Z'), calendarOf(row()))).toBe('2026-11-23');
    expect(weekStartOf(new Date('2026-11-22T22:30:00Z'), calendarOf(row()))).toBe('2026-11-16');
  });
});

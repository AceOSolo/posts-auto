import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_CALENDAR } from '../calendar/workspace-calendar.ts';
import { DEFAULT_SLOT_RULES, type OccupiedSlot, type SlotContext } from './slots.ts';
import { type MissedPost, rescheduleMissedPost } from './reschedule.ts';

const utc = (iso: string) => new Date(iso);
const ctx = (occupied: OccupiedSlot[] = []): SlotContext => ({
  calendar: DEFAULT_WORKSPACE_CALENDAR,
  rules: DEFAULT_SLOT_RULES,
  occupied,
});
const missed = (scheduledAt: string, extra: Partial<MissedPost> = {}): MissedPost => ({
  postId: 'p1',
  accountId: 'jp',
  scheduledAt: utc(scheduledAt),
  rescheduleCount: 0,
  ...extra,
});

// Novembre 2026 : Paris = UTC+1. Mardi 17/11 12h00 = 11:00Z.

describe('replanification d’un post non validé (RÈG-08 à RÈG-11, décision du 13/11/2026)', () => {
  it('ne fait rien tant que le créneau n’est pas passé', () => {
    expect(rescheduleMissedPost(missed('2026-11-17T11:00:00Z'), utc('2026-11-17T10:00:00Z'), ctx())).toEqual({
      kind: 'not_missed',
    });
  });

  it('décale au lendemain, même heure (REC-07)', () => {
    const decision = rescheduleMissedPost(missed('2026-11-17T11:00:00Z'), utc('2026-11-17T11:15:00Z'), ctx());
    expect(decision).toEqual({
      kind: 'move',
      at: utc('2026-11-18T11:00:00Z'), // mercredi 12h00
      rescheduleCount: 1,
      originalScheduledAt: utc('2026-11-17T11:00:00Z'),
      movedToAnotherWeek: false,
    });
  });

  it('passe du vendredi au lundi suivant (RÈG-09) et le signale', () => {
    const decision = rescheduleMissedPost(missed('2026-11-20T11:00:00Z'), utc('2026-11-20T11:15:00Z'), ctx());
    expect(decision).toMatchObject({ kind: 'move', at: utc('2026-11-23T11:00:00Z'), movedToAnotherWeek: true });
  });

  it('saute un jour férié (mardi 10 → jeudi 12 novembre, le 11 est férié)', () => {
    const decision = rescheduleMissedPost(missed('2026-11-10T11:00:00Z'), utc('2026-11-10T11:15:00Z'), ctx());
    expect(decision).toMatchObject({ kind: 'move', at: utc('2026-11-12T11:00:00Z') });
  });

  it('garde 12h00 heure locale à travers le changement d’heure', () => {
    // Vendredi 23/10/2026 12h00 (UTC+2) → lundi 26/10 12h00 (UTC+1).
    const decision = rescheduleMissedPost(missed('2026-10-23T10:00:00Z'), utc('2026-10-23T10:15:00Z'), ctx());
    expect(decision).toMatchObject({ kind: 'move', at: utc('2026-10-26T11:00:00Z') });
  });

  it('reprend l’heure d’origine, pas celle d’un décalage précédent', () => {
    // Mercredi 12h30 (décalé parce que 12h00 était pris) → jeudi 12h00.
    const post = missed('2026-11-18T11:30:00Z', { rescheduleCount: 1, originalScheduledAt: utc('2026-11-17T11:00:00Z') });
    const decision = rescheduleMissedPost(post, utc('2026-11-18T11:45:00Z'), ctx());
    expect(decision).toMatchObject({
      kind: 'move',
      at: utc('2026-11-19T11:00:00Z'),
      rescheduleCount: 2,
      originalScheduledAt: utc('2026-11-17T11:00:00Z'),
    });
  });

  it('prend l’heure libre la plus proche si l’heure d’origine est prise ; à égalité, la plus tardive', () => {
    const occupied = [{ postId: 'p9', accountId: 'secutop', at: utc('2026-11-18T11:00:00Z') }]; // mer. 12h00
    const decision = rescheduleMissedPost(missed('2026-11-17T11:00:00Z'), utc('2026-11-17T11:15:00Z'), ctx(occupied));
    expect(decision).toMatchObject({ kind: 'move', at: utc('2026-11-18T11:30:00Z') }); // 12h30 plutôt que 11h30
  });

  it('ramène une heure hors plage (20h00 choisie à la main) à l’heure autorisée la plus proche', () => {
    const decision = rescheduleMissedPost(missed('2026-11-17T19:00:00Z'), utc('2026-11-17T19:15:00Z'), ctx());
    expect(decision).toMatchObject({ kind: 'move', at: utc('2026-11-18T17:00:00Z') }); // mercredi 18h00
  });

  it('respecte une heure non alignée sur la grille (12h15 choisie à la main)', () => {
    const decision = rescheduleMissedPost(missed('2026-11-17T11:15:00Z'), utc('2026-11-17T11:30:00Z'), ctx());
    expect(decision).toMatchObject({ kind: 'move', at: utc('2026-11-18T11:15:00Z') });
  });

  it('rattrape une tâche en retard sans proposer un créneau déjà passé, ni à moins d’une heure', () => {
    // Manqué mardi 12h00, tâche exécutée jeudi 11h30 : jeudi 12h00 est à moins d’une heure → 12h30.
    const decision = rescheduleMissedPost(missed('2026-11-17T11:00:00Z'), utc('2026-11-19T10:30:00Z'), ctx());
    expect(decision).toMatchObject({ kind: 'move', at: utc('2026-11-19T11:30:00Z') });
  });

  it('abandonne au-delà de 5 replanifications (RÈG-10)', () => {
    const post = missed('2026-11-24T11:00:00Z', { rescheduleCount: 5 });
    expect(rescheduleMissedPost(post, utc('2026-11-24T11:15:00Z'), ctx())).toEqual({
      kind: 'abandon',
      reason: 'trop_de_replanifications',
    });
  });

  it('abandonne un post d’événement plutôt que de le publier après l’événement (RÈG-11)', () => {
    const post = missed('2026-11-17T11:00:00Z', { mustPublishBy: utc('2026-11-18T09:00:00Z') });
    expect(rescheduleMissedPost(post, utc('2026-11-17T11:15:00Z'), ctx())).toEqual({
      kind: 'abandon',
      reason: 'evenement_passe',
    });
  });

  it('abandonne si aucun créneau n’existe sur 4 semaines', () => {
    const closed = { ...ctx(), calendar: { ...DEFAULT_WORKSPACE_CALENDAR, allowedHours: {} } };
    expect(rescheduleMissedPost(missed('2026-11-17T11:00:00Z'), utc('2026-11-17T11:15:00Z'), closed)).toEqual({
      kind: 'abandon',
      reason: 'plus_de_creneau',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_CALENDAR } from '../calendar/workspace-calendar.js';
import {
  DEFAULT_SLOT_RULES,
  type OccupiedSlot,
  type SlotContext,
  checkManualSlot,
  departureForValidatedPost,
  firstFreeSlot,
  slotConflicts,
  slotForRework,
} from './slots.js';

const utc = (iso: string) => new Date(iso);
const ctx = (occupied: OccupiedSlot[] = [], rules = DEFAULT_SLOT_RULES): SlotContext => ({
  calendar: DEFAULT_WORKSPACE_CALENDAR,
  rules,
  occupied,
});
const occ = (postId: string, accountId: string, iso: string): OccupiedSlot => ({ postId, accountId, at: utc(iso) });

// Repères (heure de Paris, CET = UTC+1 en novembre) :
// mardi 17/11/2026 12h00 = 11:00Z ; 12h30 = 11:30Z ; 18h00 = 17:00Z.

describe('conflits de créneau (RÈG-03, PUB-06, RÈG-08)', () => {
  it('refuse deux posts du même compte au même instant', () => {
    const conflicts = slotConflicts(utc('2026-11-17T11:00:00Z'), 'jp', ctx([occ('p1', 'jp', '2026-11-17T11:00:00Z')]));
    expect(conflicts).toContain('same_account_same_slot');
  });

  it('plafonne à 2 posts par compte et par jour local', () => {
    const occupied = [occ('p1', 'jp', '2026-11-17T08:00:00Z'), occ('p2', 'jp', '2026-11-17T14:00:00Z')];
    expect(slotConflicts(utc('2026-11-17T16:00:00Z'), 'jp', ctx(occupied))).toEqual(['account_daily_cap']);
    // Lundi 23h30 UTC = mardi 0h30 à Paris : même jour local que les deux posts.
    expect(slotConflicts(utc('2026-11-16T23:30:00Z'), 'jp', ctx(occupied))).toContain('account_daily_cap');
    // Mercredi : libre.
    expect(slotConflicts(utc('2026-11-18T11:00:00Z'), 'jp', ctx(occupied))).toEqual([]);
  });

  it('impose 30 minutes entre deux posts de l’espace, tous comptes confondus', () => {
    const occupied = [occ('p1', 'secutop', '2026-11-17T11:00:00Z')];
    expect(slotConflicts(utc('2026-11-17T11:15:00Z'), 'jp', ctx(occupied))).toEqual(['workspace_min_gap']);
    expect(slotConflicts(utc('2026-11-17T10:45:00Z'), 'jp', ctx(occupied))).toEqual(['workspace_min_gap']);
    expect(slotConflicts(utc('2026-11-17T11:30:00Z'), 'jp', ctx(occupied))).toEqual([]); // 30 min pile : permis
  });

  it('sans écart minimal, plafonne à 2 posts de l’espace au même instant', () => {
    const rules = { ...DEFAULT_SLOT_RULES, minGapMinutesInWorkspace: 0 };
    const one = [occ('p1', 'secutop', '2026-11-17T11:00:00Z')];
    const two = [...one, occ('p2', 'simplx', '2026-11-17T11:00:00Z')];
    expect(slotConflicts(utc('2026-11-17T11:00:00Z'), 'jp', ctx(one, rules))).toEqual([]);
    expect(slotConflicts(utc('2026-11-17T11:00:00Z'), 'jp', ctx(two, rules))).toEqual(['workspace_slot_cap']);
  });

  it('ignore le post que l’on déplace', () => {
    const occupied = [occ('p1', 'jp', '2026-11-17T11:00:00Z')];
    expect(slotConflicts(utc('2026-11-17T11:00:00Z'), 'jp', ctx(occupied), 'p1')).toEqual([]);
  });
});

describe('premier créneau libre', () => {
  it('saute les créneaux trop proches d’un autre post de l’espace', () => {
    const occupied = [occ('p1', 'secutop', '2026-11-17T11:00:00Z')];
    const slot = firstFreeSlot('jp', utc('2026-11-17T10:45:00Z'), utc('2026-11-18T00:00:00Z'), ctx(occupied));
    expect(slot?.toISOString()).toBe('2026-11-17T11:30:00.000Z'); // 12h00 occupé → 12h30
  });

  it('renvoie null s’il n’y a rien avant la borne', () => {
    // Samedi et dimanche : aucune plage autorisée.
    expect(firstFreeSlot('jp', utc('2026-11-21T00:00:00Z'), utc('2026-11-22T23:00:00Z'), ctx())).toBeNull();
  });
});

describe('créneau choisi à la main (RÈG-04)', () => {
  const now = utc('2026-11-17T10:00:00Z'); // mardi 11h00

  it('exige au moins 15 minutes dans le futur', () => {
    expect(checkManualSlot(utc('2026-11-17T10:10:00Z'), 'jp', now, ctx())).toEqual({ ok: false, errors: ['too_soon'] });
    expect(checkManualSlot(utc('2026-11-17T10:15:00Z'), 'jp', now, ctx())).toEqual({ ok: true, outsideAllowedHours: false });
  });

  it('accepte un créneau hors plage mais le signale', () => {
    expect(checkManualSlot(utc('2026-11-17T19:00:00Z'), 'jp', now, ctx())).toEqual({ ok: true, outsideAllowedHours: true });
  });

  it('remonte les conflits avec les autres posts', () => {
    const result = checkManualSlot(utc('2026-11-17T11:00:00Z'), 'jp', now, ctx([occ('p1', 'jp', '2026-11-17T11:00:00Z')]));
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining(['same_account_same_slot']) });
  });
});

describe('départ d’un post validé (RÈG-06, RÈG-11, RÈG-22)', () => {
  const tuesdayNoon = utc('2026-11-17T11:00:00Z');
  const post = { postId: 'p1', accountId: 'jp', scheduledAt: tuesdayNoon };

  it('garde un créneau encore à venir', () => {
    expect(departureForValidatedPost(post, utc('2026-11-17T09:00:00Z'), ctx())).toEqual({ kind: 'keep', at: tuesdayNoon });
  });

  it('part tout de suite s’il est validé 10 minutes après son créneau (REC-06)', () => {
    const now = utc('2026-11-17T11:10:00Z');
    expect(departureForValidatedPost(post, now, ctx())).toEqual({ kind: 'depart_now', at: now });
  });

  it('validé mardi soir hors plage : part au premier créneau autorisé, mercredi 8h00', () => {
    const decision = departureForValidatedPost(post, utc('2026-11-17T19:00:00Z'), ctx());
    expect(decision).toEqual({ kind: 'move', at: utc('2026-11-18T07:00:00Z') });
  });

  it('validé la semaine suivante : ne part pas « immédiatement », il prend un créneau de la grille', () => {
    const decision = departureForValidatedPost(post, utc('2026-11-23T08:10:00Z'), ctx()); // lundi 9h10
    expect(decision).toEqual({ kind: 'move', at: utc('2026-11-23T08:30:00Z') }); // lundi 9h30
  });

  it('attend le créneau libre suivant si un autre post de l’espace vient de partir', () => {
    const occupied = [occ('p2', 'secutop', '2026-11-17T11:00:00Z')];
    const decision = departureForValidatedPost(post, utc('2026-11-17T11:10:00Z'), ctx(occupied));
    expect(decision).toEqual({ kind: 'move', at: utc('2026-11-17T11:30:00Z') });
  });

  it('abandonne un post d’événement si l’événement est passé', () => {
    const eventPost = { ...post, mustPublishBy: utc('2026-11-17T17:00:00Z') };
    expect(departureForValidatedPost(eventPost, utc('2026-11-17T19:00:00Z'), ctx())).toEqual({
      kind: 'abandon',
      reason: 'evenement_passe',
    });
  });

  it('abandonne si le seul créneau possible tombe après l’événement', () => {
    // Validé mardi 19h00, événement mardi 23h59 : le prochain créneau (mercredi 8h00) est trop tard.
    const eventPost = { ...post, mustPublishBy: utc('2026-11-17T22:59:00Z') };
    expect(departureForValidatedPost(eventPost, utc('2026-11-17T18:00:00Z'), ctx())).toEqual({
      kind: 'abandon',
      reason: 'evenement_passe',
    });
  });
});

describe('créneau d’une reprise (RÈG-14)', () => {
  const now = utc('2026-11-17T08:00:00Z'); // mardi 9h00

  it('garde le créneau du post remplacé s’il est à plus de 3 heures', () => {
    const replaced = { postId: 'p1', accountId: 'jp', scheduledAt: utc('2026-11-17T13:00:00Z') }; // 14h00
    // Le post remplacé occupe encore son créneau : il est ignoré.
    const decision = slotForRework(replaced, now, ctx([occ('p1', 'jp', '2026-11-17T13:00:00Z')]));
    expect(decision).toEqual({ kind: 'keep', at: replaced.scheduledAt });
  });

  it('cherche un créneau à partir de maintenant + 3 h si le créneau est trop proche', () => {
    const replaced = { postId: 'p1', accountId: 'jp', scheduledAt: utc('2026-11-17T09:00:00Z') }; // 10h00
    expect(slotForRework(replaced, now, ctx())).toEqual({ kind: 'move', at: utc('2026-11-17T11:00:00Z') }); // 12h00
  });

  it('abandonne s’il n’y a aucun créneau libre sur 2 semaines', () => {
    const replaced = { postId: 'p1', accountId: 'jp', scheduledAt: utc('2026-11-17T09:00:00Z') };
    const closedCalendar = { ...DEFAULT_WORKSPACE_CALENDAR, allowedHours: {} };
    const context = { ...ctx(), calendar: closedCalendar };
    expect(slotForRework(replaced, now, context)).toEqual({ kind: 'abandon', reason: 'plus_de_creneau' });
  });
});

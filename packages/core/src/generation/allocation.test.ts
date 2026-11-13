import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_CALENDAR } from '../calendar/workspace-calendar.ts';
import { DEFAULT_SLOT_RULES, type OccupiedSlot } from '../scheduling/slots.ts';
import {
  type AllocationAccount,
  type AllocationInput,
  type Assignment,
  type Subject,
  type WindowPost,
  addDays,
  allocateSubjects,
  postRank,
} from './allocation.ts';

// Lundi 16 novembre 2026, 7h30 à Paris : heure par défaut de la génération (GEN-01).
const NOW = new Date('2026-11-16T06:30:00Z');
const OLD = new Date('2026-11-01T00:00:00Z');
const WEEKS = ['2026-11-16', '2026-11-23'];
const paris = (local: string) => new Date(`${local}+01:00`);

const A: AllocationAccount = { id: 'A', postsPerWeek: 1, optionalPerWeek: 0, usualSlots: [{ weekday: 2, time: '12:00' }] };
const B: AllocationAccount = {
  id: 'B',
  postsPerWeek: 2,
  optionalPerWeek: 1,
  usualSlots: [
    { weekday: 3, time: '12:00' },
    { weekday: 4, time: '09:00' },
  ],
};

function input(overrides: Partial<AllocationInput> & { occupied?: OccupiedSlot[] } = {}): AllocationInput {
  const { occupied = [], ...rest } = overrides;
  return {
    now: NOW,
    weeks: WEEKS,
    accounts: [A],
    subjects: [],
    windowPosts: [],
    slots: { calendar: DEFAULT_WORKSPACE_CALENDAR, rules: DEFAULT_SLOT_RULES, occupied },
    ...rest,
  };
}

let n = 0;
const cell = (accountId: string, weekStart: string, createdAt = OLD): Subject => ({
  kind: 'planning_cell',
  id: `cell-${(n += 1)}`,
  accountId,
  weekStart,
  content: 'Sujet planifié',
  createdAt,
});
const event = (startsOn: string, accountIds: string[], createdAt = OLD): Subject => ({
  kind: 'event',
  id: `event-${(n += 1)}`,
  title: 'Salon',
  startsOn,
  accountIds,
  createdAt,
});
const idea = (values: Partial<Extract<Subject, { kind: 'idea' }>> = {}): Subject => ({
  kind: 'idea',
  id: `idea-${(n += 1)}`,
  title: 'Idée',
  origin: 'team',
  accountIds: 'all',
  startsOn: null,
  endsOn: null,
  eventOn: null,
  targetWeek: null,
  createdAt: OLD,
  ...values,
});
const bank = (accountId: string | null, createdAt = OLD): Subject => ({ kind: 'bank', id: `bank-${(n += 1)}`, accountId, subject: 'Ligne de banque', createdAt });

function post(values: Partial<WindowPost> & Pick<WindowPost, 'accountId' | 'weekStart' | 'scheduledAt'>): WindowPost {
  return {
    id: `post-${(n += 1)}`,
    status: 'a_valider',
    origin: 'ai_idea',
    planningCellId: null,
    subjectId: null,
    isOptional: false,
    createdAt: OLD,
    editedByHuman: false,
    ...values,
  };
}
const occupiedBy = (posts: WindowPost[]): OccupiedSlot[] => posts.map((p) => ({ postId: p.id, accountId: p.accountId, at: p.scheduledAt }));
const summary = (assignments: readonly Assignment[]) =>
  assignments.map((a) => ({ account: a.accountId, week: a.weekStart, at: a.at.toISOString(), origin: a.origin, kind: a.subject?.kind ?? 'ia' }));

describe('rythme du compte et choix de l’IA (GEN-01, GEN-02 rang 6)', () => {
  it('sans aucun sujet, chaque créneau habituel des 2 semaines reçoit un sujet choisi par l’IA', () => {
    const result = allocateSubjects(input());
    expect(summary(result.assignments)).toEqual([
      { account: 'A', week: '2026-11-16', at: paris('2026-11-17T12:00').toISOString(), origin: 'ai_idea', kind: 'ia' },
      { account: 'A', week: '2026-11-23', at: paris('2026-11-24T12:00').toISOString(), origin: 'ai_idea', kind: 'ia' },
    ]);
    expect(result.unplaced).toEqual([]);
  });

  it('les posts déjà présents comptent dans le rythme, sauf les posts ponctuels, remplacés ou abandonnés', () => {
    const existing = [
      post({ accountId: 'A', weekStart: '2026-11-16', scheduledAt: paris('2026-11-17T12:00'), status: 'modif' }),
      post({ accountId: 'A', weekStart: '2026-11-23', scheduledAt: paris('2026-11-24T12:00'), status: 'remplace' }),
      post({ accountId: 'A', weekStart: '2026-11-23', scheduledAt: paris('2026-11-25T10:00'), origin: 'request' }),
    ];
    const result = allocateSubjects(input({ windowPosts: existing, occupied: occupiedBy([existing[2] as WindowPost]) }));
    expect(summary(result.assignments).map((a) => [a.week, a.at])).toEqual([['2026-11-23', paris('2026-11-24T12:00').toISOString()]]);
  });

  it('un nouveau post est placé au moins 3 heures après la génération', () => {
    // Mardi 17, 10h00 : le créneau de 12h00 est trop proche, on prend la grille à partir de 13h00.
    const result = allocateSubjects(input({ now: paris('2026-11-17T10:00') }));
    expect(result.assignments[0]?.at).toEqual(paris('2026-11-17T13:00'));
  });

  it('respecte l’écart entre deux posts de l’espace (PUB-06)', () => {
    const result = allocateSubjects(input({ accounts: [A, { ...A, id: 'A2' }] }));
    const tuesday = summary(result.assignments).filter((a) => a.week === '2026-11-16');
    expect(tuesday.map((a) => [a.account, a.at])).toEqual([
      ['A', paris('2026-11-17T12:00').toISOString()],
      // Le créneau habituel est pris par A : premier créneau libre de la grille, 3 h après 7h30.
      ['A2', paris('2026-11-16T10:30').toISOString()],
    ]);
  });
});

describe('ordre de priorité des sujets (GEN-02)', () => {
  it('case du planning, puis événement, puis idée, puis banque : chacun sur le rythme du compte', () => {
    const subjects = [bank('A'), idea(), event('2026-12-03', ['A']), cell('A', '2026-11-16')];
    const result = allocateSubjects(input({ subjects }));
    expect(summary(result.assignments).map((a) => [a.week, a.kind])).toEqual([
      ['2026-11-16', 'planning_cell'],
      ['2026-11-23', 'event'],
    ]);
  });

  it('une case du planning est toujours rédigée, au-delà du rythme si besoin (décision 0005)', () => {
    const result = allocateSubjects(input({ subjects: [cell('A', '2026-11-16'), cell('A', '2026-11-16')] }));
    expect(summary(result.assignments).map((a) => [a.week, a.kind, a.at])).toEqual([
      ['2026-11-16', 'planning_cell', paris('2026-11-17T12:00').toISOString()],
      ['2026-11-16', 'planning_cell', paris('2026-11-16T10:30').toISOString()],
      ['2026-11-23', 'ia', paris('2026-11-24T12:00').toISOString()],
    ]);
  });

  it('une banque commune alimente le premier compte qui a de la place', () => {
    const result = allocateSubjects(input({ accounts: [A, { ...B, optionalPerWeek: 0 }], subjects: [bank(null), bank('B')] }));
    expect(summary(result.assignments).filter((a) => a.kind === 'bank').map((a) => [a.account, a.week])).toEqual([
      ['A', '2026-11-16'],
      ['B', '2026-11-16'],
    ]);
  });

  it('une idée donne un seul post, au plus tôt, sur un des comptes visés', () => {
    const result = allocateSubjects(input({ accounts: [A, B], subjects: [idea({ accountIds: ['B', 'A'] })] }));
    const ideas = result.assignments.filter((a) => a.subject?.kind === 'idea');
    expect(ideas.map((a) => [a.accountId, a.weekStart, a.origin])).toEqual([['A', '2026-11-16', 'team_idea']]);
  });

  it('une idée datée respecte sa période, sa semaine visée et la date de son événement', () => {
    const late = idea({ startsOn: '2026-11-25' });
    const targeted = idea({ targetWeek: '2026-11-23' });
    const before = idea({ eventOn: '2026-11-18', accountIds: ['B'] });
    const result = allocateSubjects(input({ accounts: [A, B], subjects: [late, targeted, before] }));
    const placed = new Map(result.assignments.filter((a) => a.subject !== null).map((a) => [a.subject?.id, a]));
    expect(placed.get(late.id)?.weekStart).toBe('2026-11-23');
    expect(placed.get(targeted.id)?.weekStart).toBe('2026-11-23');
    expect(placed.get(before.id)?.at.getTime()).toBeLessThan(paris('2026-11-18T00:00').getTime());
    expect(placed.get(before.id)?.mustPublishBy).toEqual(paris('2026-11-18T00:00'));
  });

  it('la réserve sert les posts en option quand le rythme est plein', () => {
    const reserve = idea({ origin: 'ai_reserve', accountIds: ['B'] });
    const subjects = [bank('B'), bank('B'), bank('B'), bank('B'), reserve];
    const result = allocateSubjects(input({ accounts: [B], subjects }));
    const optional = result.assignments.filter((a) => a.isOptional);
    expect(optional.map((a) => [a.subject?.kind, a.weekStart])).toEqual([['idea', '2026-11-16']]);
    expect(optional[0]?.origin).toBe('ai_reserve');
  });
});

describe('événements (PLA-04)', () => {
  it('relayé dans la semaine la plus proche avant l’événement, sur chaque compte choisi, jamais après', () => {
    const result = allocateSubjects(input({ accounts: [A, B], subjects: [event('2026-11-25', ['A', 'B'])] }));
    const relays = result.assignments.filter((a) => a.subject?.kind === 'event');
    expect(relays.map((a) => [a.accountId, a.at.toISOString()])).toEqual([
      ['A', paris('2026-11-24T12:00').toISOString()],
      // Mercredi 25 est le jour de l'événement : B prend le premier créneau libre avant.
      ['B', paris('2026-11-23T08:00').toISOString()],
    ]);
    expect(relays.every((a) => a.mustPublishBy?.getTime() === paris('2026-11-25T00:00').getTime())).toBe(true);
  });

  it('un événement à plus de 3 semaines n’est pas encore relayé', () => {
    const result = allocateSubjects(input({ subjects: [event('2026-12-21', ['A'])] }));
    expect(result.assignments.every((a) => a.subject === null)).toBe(true);
    expect(result.unplaced).toMatchObject([{ reason: 'no_slot', accountId: 'A' }]);
  });

  it('un compte en pause ne relaie pas : l’absence est signalée', () => {
    const result = allocateSubjects(input({ subjects: [event('2026-11-25', ['paused']), cell('paused', '2026-11-16')] }));
    expect(result.unplaced.map((u) => [u.subject?.kind, u.reason])).toEqual([
      ['planning_cell', 'account_inactive'],
      ['event', 'account_inactive'],
    ]);
  });
});

describe('fenêtre glissante et remplacement (GEN-03, REC-04)', () => {
  const NEW = new Date('2026-11-15T00:00:00Z');
  const aiPosts = () => [
    post({ accountId: 'A', weekStart: '2026-11-16', scheduledAt: paris('2026-11-17T12:00') }),
    post({ accountId: 'A', weekStart: '2026-11-23', scheduledAt: paris('2026-11-24T12:00') }),
  ];

  it('un événement apparu après la rédaction remplace le post le moins prioritaire et reprend son créneau', () => {
    const existing = aiPosts();
    const result = allocateSubjects(input({ windowPosts: existing, occupied: occupiedBy(existing), subjects: [event('2026-11-26', ['A'], NEW)] }));
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({ replacesPostId: existing[1]?.id, at: existing[1]?.scheduledAt, origin: 'event' });
  });

  it('aucun remplacement par une matière plus ancienne que le post, ni par la réserve', () => {
    const existing = aiPosts();
    const reserve = idea({ origin: 'ai_reserve', createdAt: NEW });
    const result = allocateSubjects(input({ windowPosts: existing, occupied: occupiedBy(existing), subjects: [event('2026-11-26', ['A']), reserve] }));
    expect(result.assignments).toEqual([]);
    expect(result.unplaced.map((u) => u.subject?.kind)).toEqual(['event']);
  });

  it('jamais un post validé, corrigé par une personne, ponctuel, ou dont le créneau approche', () => {
    const protectedPosts = [
      post({ accountId: 'A', weekStart: '2026-11-16', scheduledAt: paris('2026-11-16T09:00') }), // dans moins de 3 h
      post({ accountId: 'A', weekStart: '2026-11-23', scheduledAt: paris('2026-11-24T12:00'), status: 'valide' }),
    ];
    const edited = post({ accountId: 'A', weekStart: '2026-11-23', scheduledAt: paris('2026-11-26T12:00'), editedByHuman: true, isOptional: true });
    const existing = [...protectedPosts, edited];
    const result = allocateSubjects(input({ windowPosts: existing, occupied: occupiedBy(existing), subjects: [cell('A', '2026-11-23', NEW)] }));
    // La case est rédigée en plus, sans rien remplacer.
    expect(result.assignments).toMatchObject([{ replacesPostId: null, weekStart: '2026-11-23' }]);
  });

  it('un post « planning » déposé par l’API d’échange compte comme une case : jamais remplacé', () => {
    expect(postRank({ origin: 'planning', planningCellId: null, subjectId: null })).toBe(1);
    expect(postRank({ origin: 'planning', planningCellId: null, subjectId: 's' })).toBe(4);
    expect(postRank({ origin: 'request', planningCellId: null, subjectId: null })).toBe(0);
  });

  it('relancer la génération sur un état complet ne produit rien (REC-04)', () => {
    const first = allocateSubjects(input({ accounts: [A, B] }));
    const existing = first.assignments.map((a) =>
      post({ accountId: a.accountId, weekStart: a.weekStart, scheduledAt: a.at, isOptional: a.isOptional, createdAt: NOW }),
    );
    const second = allocateSubjects(input({ accounts: [A, B], windowPosts: existing, occupied: occupiedBy(existing) }));
    expect(second.assignments).toEqual([]);
  });
});

describe('dates civiles', () => {
  it('ajoute des jours sans dépendre du fuseau, y compris au changement d’heure', () => {
    expect(addDays('2026-10-24', 7)).toBe('2026-10-31');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
  });
});

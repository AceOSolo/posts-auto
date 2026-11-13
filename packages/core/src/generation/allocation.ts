/**
 * Affectation des sujets aux créneaux pour la rédaction hebdomadaire (GEN-01 à GEN-03,
 * PLA-04, décision 0005).
 *
 * Le code choisit les sujets ; l'IA ne fait que rédiger. Pour chaque compte et chaque
 * semaine de la fenêtre glissante (semaine en cours et suivante), les sujets sont pris
 * dans l'ordre de GEN-02 :
 *   1. cases du planning ;
 *   2. événements à relayer (dans les 3 semaines qui précèdent) ;
 *   3. idées de l'équipe ;
 *   4. banque de sujets du compte ;
 *   5. réserve de l'IA ;
 *   6. autre matière vérifiable, choisie par l'IA pour les créneaux restants.
 *
 * Fonction pure : elle reçoit l'état (posts de la fenêtre, sujets non traités,
 * occupation des créneaux) et rend des affectations, sans rien écrire.
 */
import {
  type UsualSlot,
  type WorkspaceCalendar,
  addMinutes,
  atLocal,
  usualSlotsInWeek,
} from '../calendar/workspace-calendar.ts';
import type { PostStatus } from '../posts/status.ts';
import { type OccupiedSlot, type SlotContext, firstFreeSlot, isSlotFree } from '../scheduling/slots.ts';

/** Origine affichée d'un post (GEN-06). */
export const POST_ORIGINS = ['planning', 'event', 'team_idea', 'ai_idea', 'ai_reserve', 'request', 'external_source'] as const;
export type PostOrigin = (typeof POST_ORIGINS)[number];

/** Un nouveau post est placé au moins 3 heures après la génération, pour laisser le temps de valider (comme RÈG-14). */
export const GENERATION_MIN_LEAD_MINUTES = 180;
/** Un post « à valider » dont le créneau est à moins de 3 heures n'est plus remplacé : son titulaire est peut-être en train de le lire. */
export const REPLACE_MIN_LEAD_MINUTES = 180;
/** PLA-04 : un événement est relayé dans les 3 semaines qui le précèdent. */
export const EVENT_RELAY_DAYS = 21;

/** Rang de priorité de GEN-02 : 1 est le plus prioritaire. */
export type SubjectRank = 1 | 2 | 3 | 4 | 5 | 6;

interface SubjectBase {
  readonly id: string;
  /** Date d'apparition : seule une matière apparue après un post peut le remplacer (GEN-03). */
  readonly createdAt: Date;
}

export type Subject = SubjectBase &
  (
  | {
      readonly kind: 'planning_cell';
      readonly accountId: string;
      readonly weekStart: string;
      readonly content: string;
    }
  | {
      readonly kind: 'event';
      readonly title: string;
      readonly startsOn: string;
      /** Comptes qui n'ont pas encore relayé l'événement. */
      readonly accountIds: readonly string[];
    }
  | {
      readonly kind: 'idea';
      readonly title: string;
      readonly origin: 'team' | 'ai_reserve';
      readonly accountIds: readonly string[] | 'all';
      readonly startsOn: string | null;
      readonly endsOn: string | null;
      readonly eventOn: string | null;
      readonly targetWeek: string | null;
    }
  | {
      readonly kind: 'bank';
      /** `null` : sujet commun à tous les comptes de l'espace. */
      readonly accountId: string | null;
      readonly subject: string;
    }
  );

export function subjectRank(subject: Subject): SubjectRank {
  switch (subject.kind) {
    case 'planning_cell':
      return 1;
    case 'event':
      return 2;
    case 'idea':
      return subject.origin === 'team' ? 3 : 5;
    case 'bank':
      return 4;
  }
}

export function subjectOrigin(subject: Subject): PostOrigin {
  switch (subject.kind) {
    case 'planning_cell':
    case 'bank':
      return 'planning';
    case 'event':
      return 'event';
    case 'idea':
      return subject.origin === 'team' ? 'team_idea' : 'ai_reserve';
  }
}

/**
 * Rang d'un post existant, déduit de son origine. Un post « planning » sans case ni ligne
 * de banque (déposé par l'API d'échange) est traité comme une case : jamais remplacé.
 * Un post ponctuel (demande) a le rang 0 : il n'est jamais remplacé.
 */
export function postRank(post: { readonly origin: PostOrigin; readonly planningCellId: string | null; readonly subjectId: string | null }): number {
  switch (post.origin) {
    case 'request':
      return 0;
    case 'planning':
      return post.planningCellId === null && post.subjectId !== null ? 4 : 1;
    case 'event':
      return 2;
    case 'team_idea':
      return 3;
    case 'ai_reserve':
      return 5;
    case 'ai_idea':
    case 'external_source':
      return 6;
  }
}

/** Post d'un compte dont la semaine est dans la fenêtre. */
export interface WindowPost {
  readonly id: string;
  readonly accountId: string;
  readonly weekStart: string;
  readonly scheduledAt: Date;
  readonly status: PostStatus;
  readonly origin: PostOrigin;
  readonly planningCellId: string | null;
  readonly subjectId: string | null;
  readonly isOptional: boolean;
  readonly createdAt: Date;
  /** Une personne a corrigé le texte : le post n'est plus remplacé (décision 0005). */
  readonly editedByHuman: boolean;
}

/** Fiche du compte (EDI-04), réduite à ce qui sert à l'affectation. */
export interface AllocationAccount {
  readonly id: string;
  readonly postsPerWeek: number;
  readonly optionalPerWeek: number;
  readonly usualSlots: readonly UsualSlot[];
}

export interface AllocationInput {
  readonly now: Date;
  /** Lundis (dates locales) des semaines de la fenêtre, dans l'ordre. */
  readonly weeks: readonly string[];
  /** Comptes à alimenter (connectés, hors pause), dans l'ordre d'affichage. */
  readonly accounts: readonly AllocationAccount[];
  /** Sujets pas encore traités, chaque rang dans l'ordre voulu (position, date de création…). */
  readonly subjects: readonly Subject[];
  /** Posts de ces comptes dans la fenêtre, tous statuts. */
  readonly windowPosts: readonly WindowPost[];
  /** Occupation des créneaux de l'espace (posts qui occupent un créneau). */
  readonly slots: SlotContext;
}

export interface Assignment {
  readonly accountId: string;
  readonly weekStart: string;
  readonly at: Date;
  /** `null` : sujet laissé au choix de l'IA (rang 6). */
  readonly subject: Subject | null;
  readonly origin: PostOrigin;
  readonly rank: SubjectRank;
  readonly isOptional: boolean;
  /** RÈG-11 : date limite (événement, idée datée). */
  readonly mustPublishBy: Date | null;
  /** GEN-03 : post « à valider » remplacé par ce sujet plus prioritaire ; il libère son créneau. */
  readonly replacesPostId: string | null;
}

export type UnplacedReason =
  /** Aucun créneau libre dans les semaines possibles. */
  | 'no_slot'
  /** Le compte visé n'est pas alimenté (déconnecté, en pause, retiré). */
  | 'account_inactive';

export interface Unplaced {
  /** `null` : créneau du rythme du compte que l'IA aurait dû remplir. */
  readonly subject: Subject | null;
  readonly accountId: string | null;
  readonly weekStart: string | null;
  readonly reason: UnplacedReason;
}

export interface AllocationResult {
  readonly assignments: readonly Assignment[];
  readonly unplaced: readonly Unplaced[];
}

/** AAAA-MM-JJ + n jours (dates civiles, sans fuseau). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Début d'un jour local de l'espace (minuit existe toujours en Europe). */
export function startOfLocalDay(date: string, calendar: WorkspaceCalendar): Date {
  const instant = atLocal(date, '00:00', calendar);
  if (instant === null) throw new Error(`Minuit n'existe pas le ${date} dans ${calendar.timeZone}`);
  return instant;
}

const INACTIVE_STATUSES: ReadonlySet<PostStatus> = new Set<PostStatus>(['remplace', 'abandonne']);

interface Bucket {
  regular: number;
  optional: number;
  readonly replaceable: WindowPost[];
}

/** Une unité à placer : un sujet, avec la liste ordonnée des (compte, semaine) possibles. */
interface Unit {
  readonly subject: Subject;
  readonly candidates: readonly { readonly accountId: string; readonly weekStart: string }[];
  readonly mustPublishBy: Date | null;
  /** Compte visé quand aucun candidat n'existe (pour le rapport). */
  readonly accountHint: string | null;
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

export function allocateSubjects(input: AllocationInput): AllocationResult {
  const { now, weeks, accounts, slots } = input;
  const calendar = slots.calendar;
  const activeIds = accounts.map((a) => a.id);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const occupied: OccupiedSlot[] = [...slots.occupied];
  const context = (): SlotContext => ({ ...slots, occupied });
  const earliest = addMinutes(now, GENERATION_MIN_LEAD_MINUTES);
  const replaceAfter = addMinutes(now, REPLACE_MIN_LEAD_MINUTES);

  // Occupation du rythme de chaque compte, semaine par semaine.
  const buckets = new Map<string, Bucket>();
  const bucketOf = (accountId: string, weekStart: string): Bucket => {
    const key = `${accountId}|${weekStart}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { regular: 0, optional: 0, replaceable: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const post of input.windowPosts) {
    if (INACTIVE_STATUSES.has(post.status) || post.origin === 'request') continue;
    const bucket = bucketOf(post.accountId, post.weekStart);
    if (post.isOptional) bucket.optional += 1;
    else bucket.regular += 1;
    if (post.status === 'a_valider' && !post.editedByHuman && post.scheduledAt.getTime() >= replaceAfter.getTime()) {
      bucket.replaceable.push(post);
    }
  }

  /** Premier créneau libre du compte dans la semaine : créneaux habituels d'abord, puis la grille. */
  const findSlot = (accountId: string, weekStart: string, mustPublishBy: Date | null): Date | null => {
    const weekBegin = startOfLocalDay(weekStart, calendar);
    const from = weekBegin.getTime() > earliest.getTime() ? weekBegin : earliest;
    const until = minDate(startOfLocalDay(addDays(weekStart, 7), calendar), mustPublishBy) as Date;
    if (until.getTime() <= from.getTime()) return null;
    const account = accountById.get(accountId);
    for (const usual of usualSlotsInWeek(weekBegin, account?.usualSlots ?? [], calendar)) {
      if (usual.getTime() >= from.getTime() && usual.getTime() < until.getTime() && isSlotFree(usual, accountId, context())) {
        return usual;
      }
    }
    return firstFreeSlot(accountId, from, until, context());
  };

  const assignments: Assignment[] = [];
  const unplaced: Unplaced[] = [];

  const place = (
    unit: { subject: Subject | null; mustPublishBy: Date | null },
    accountId: string,
    weekStart: string,
    at: Date,
    isOptional: boolean,
    replaced: WindowPost | null,
  ) => {
    const bucket = bucketOf(accountId, weekStart);
    if (replaced === null) {
      if (isOptional) bucket.optional += 1;
      else bucket.regular += 1;
    } else {
      bucket.replaceable.splice(bucket.replaceable.indexOf(replaced), 1);
      const index = occupied.findIndex((slot) => slot.postId === replaced.id);
      if (index !== -1) occupied.splice(index, 1);
    }
    occupied.push({ postId: `nouveau:${assignments.length}`, accountId, at });
    const subject = unit.subject;
    assignments.push({
      accountId,
      weekStart,
      at,
      subject,
      origin: subject === null ? 'ai_idea' : subjectOrigin(subject),
      rank: subject === null ? 6 : subjectRank(subject),
      isOptional,
      mustPublishBy: unit.mustPublishBy,
      replacesPostId: replaced?.id ?? null,
    });
  };

  const tryCapacity = (unit: Unit, kind: 'regular' | 'optional'): boolean => {
    for (const { accountId, weekStart } of unit.candidates) {
      const account = accountById.get(accountId);
      if (account === undefined) continue;
      const bucket = bucketOf(accountId, weekStart);
      const left = kind === 'regular' ? account.postsPerWeek - bucket.regular : account.optionalPerWeek - bucket.optional;
      if (left <= 0) continue;
      const at = findSlot(accountId, weekStart, unit.mustPublishBy);
      if (at !== null) {
        place(unit, accountId, weekStart, at, kind === 'optional', null);
        return true;
      }
    }
    return false;
  };

  /**
   * GEN-03 : un post « à valider » n'est remplacé que par une matière plus intéressante
   * **apparue** depuis sa rédaction : sujet de rang 1 à 4, strictement mieux classé, créé
   * après le post. La réserve et les sujets remis en circulation ne remplacent jamais :
   * sinon chaque remplacement en déclencherait un autre à la génération suivante.
   */
  const tryReplace = (unit: Unit): boolean => {
    const rank = subjectRank(unit.subject);
    if (rank > MAX_REPLACING_RANK) return false;
    for (const { accountId, weekStart } of unit.candidates) {
      const victims = bucketOf(accountId, weekStart)
        .replaceable.filter((post) => postRank(post) > rank)
        .filter((post) => unit.subject.createdAt.getTime() > post.createdAt.getTime())
        .filter((post) => unit.mustPublishBy === null || post.scheduledAt.getTime() < unit.mustPublishBy.getTime())
        // Le moins prioritaire d'abord ; à égalité, le plus tardif.
        .sort((a, b) => postRank(b) - postRank(a) || b.scheduledAt.getTime() - a.scheduledAt.getTime());
      const victim = victims[0];
      if (victim !== undefined) {
        place(unit, accountId, weekStart, victim.scheduledAt, victim.isOptional, victim);
        return true;
      }
    }
    return false;
  };

  const tryExtra = (unit: Unit): boolean => {
    for (const { accountId, weekStart } of unit.candidates) {
      const at = findSlot(accountId, weekStart, unit.mustPublishBy);
      if (at !== null) {
        place(unit, accountId, weekStart, at, false, null);
        return true;
      }
    }
    return false;
  };

  for (const unit of buildUnits(input, activeIds)) {
    if (unit.candidates.length === 0) {
      if (mustReport(unit.subject)) {
        const inactive = unit.accountHint !== null && !accountById.has(unit.accountHint);
        unplaced.push({ subject: unit.subject, accountId: unit.accountHint, weekStart: null, reason: inactive ? 'account_inactive' : 'no_slot' });
      }
      continue;
    }
    // Décision 0005 : une case du planning est toujours rédigée ; elle prend d'abord la
    // place du rythme, puis celle d'un post moins prioritaire, enfin un créneau en plus.
    const placed =
      unit.subject.kind === 'planning_cell'
        ? tryCapacity(unit, 'regular') || tryReplace(unit) || tryExtra(unit)
        : tryCapacity(unit, 'regular') || tryCapacity(unit, 'optional') || tryReplace(unit);
    if (!placed && mustReport(unit.subject)) {
      const first = unit.candidates[0];
      unplaced.push({ subject: unit.subject, accountId: first?.accountId ?? null, weekStart: first?.weekStart ?? null, reason: 'no_slot' });
    }
  }

  // Rang 6 : les créneaux du rythme encore vides sont laissés au choix de l'IA.
  for (const account of accounts) {
    for (const weekStart of weeks) {
      while (account.postsPerWeek - bucketOf(account.id, weekStart).regular > 0) {
        const at = findSlot(account.id, weekStart, null);
        if (at === null) {
          unplaced.push({ subject: null, accountId: account.id, weekStart, reason: 'no_slot' });
          break;
        }
        place({ subject: null, mustPublishBy: null }, account.id, weekStart, at, false, null);
      }
    }
  }

  return { assignments, unplaced };
}

/** Rang le moins prioritaire qui puisse remplacer un post (la banque de sujets). */
export const MAX_REPLACING_RANK = 4;

/**
 * Sujets dont l'absence de créneau est signalée au rapport et à l'inventaire (PLA-08) :
 * ceux qui sont datés. Une idée, une ligne de banque ou un sujet de réserve qui attend
 * une semaine plus creuse est la situation normale.
 */
function mustReport(subject: Subject): boolean {
  return subject.kind === 'planning_cell' || subject.kind === 'event' || (subject.kind === 'idea' && (subject.targetWeek !== null || subject.eventOn !== null));
}

/** Transforme les sujets en unités à placer, triées par rang (tri stable : l'ordre fourni est conservé à rang égal). */
function buildUnits(input: AllocationInput, activeIds: readonly string[]): Unit[] {
  const { weeks } = input;
  const calendar = input.slots.calendar;
  const active = new Set(activeIds);
  const weekSet = new Set(weeks);
  const units: Unit[] = [];

  const sorted = [...input.subjects].sort((a, b) => subjectRank(a) - subjectRank(b));
  for (const subject of sorted) {
    switch (subject.kind) {
      case 'planning_cell': {
        const ok = active.has(subject.accountId) && weekSet.has(subject.weekStart);
        units.push({
          subject,
          candidates: ok ? [{ accountId: subject.accountId, weekStart: subject.weekStart }] : [],
          mustPublishBy: null,
          accountHint: subject.accountId,
        });
        break;
      }
      case 'event': {
        // Semaines qui ont au moins un jour dans les 3 semaines avant l'événement ; la plus proche de l'événement d'abord.
        const relayFrom = addDays(subject.startsOn, -EVENT_RELAY_DAYS);
        const eligible = weeks.filter((w) => w < subject.startsOn && addDays(w, 7) > relayFrom).reverse();
        const mustPublishBy = startOfLocalDay(subject.startsOn, calendar);
        for (const accountId of subject.accountIds) {
          units.push({
            subject,
            candidates: active.has(accountId) ? eligible.map((weekStart) => ({ accountId, weekStart })) : [],
            mustPublishBy,
            accountHint: accountId,
          });
        }
        break;
      }
      case 'idea': {
        // Ordre des comptes de l'espace, quel que soit l'ordre de sélection.
        const targets = subject.accountIds === 'all' ? activeIds : activeIds.filter((id) => subject.accountIds.includes(id));
        const limits = [
          subject.eventOn === null ? null : startOfLocalDay(subject.eventOn, calendar),
          subject.endsOn === null ? null : startOfLocalDay(addDays(subject.endsOn, 1), calendar),
        ];
        const mustPublishBy = minDate(limits[0] ?? null, limits[1] ?? null);
        const eligible = weeks.filter(
          (w) =>
            (subject.targetWeek === null || subject.targetWeek === w) &&
            (subject.startsOn === null || addDays(w, 7) > subject.startsOn) &&
            (subject.endsOn === null || w <= subject.endsOn) &&
            (subject.eventOn === null || w < subject.eventOn),
        );
        units.push({
          subject,
          // Au plus tôt, puis dans l'ordre des comptes : une idée donne un seul post.
          candidates: eligible.flatMap((weekStart) => targets.map((accountId) => ({ accountId, weekStart }))),
          mustPublishBy,
          accountHint: subject.accountIds === 'all' ? null : (subject.accountIds[0] ?? null),
        });
        break;
      }
      case 'bank': {
        const targets = subject.accountId === null ? activeIds : active.has(subject.accountId) ? [subject.accountId] : [];
        units.push({
          subject,
          candidates: weeks.flatMap((weekStart) => targets.map((accountId) => ({ accountId, weekStart }))),
          mustPublishBy: null,
          accountHint: subject.accountId,
        });
        break;
      }
    }
  }
  return units;
}

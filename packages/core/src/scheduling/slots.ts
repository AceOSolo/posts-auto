/**
 * Occupation des créneaux et choix d'un créneau (cahier des charges, RÈG-03, RÈG-04,
 * RÈG-06, RÈG-14, RÈG-22 et PUB-06).
 *
 * Toutes les fonctions sont pures : on leur passe les posts qui occupent déjà un
 * créneau dans l'espace, elles disent si un créneau est libre ou lequel choisir.
 */
import {
  type WorkspaceCalendar,
  addMinutes,
  allowedSlots,
  isWithinAllowedHours,
  localDate,
  sameIsoWeek,
} from '../calendar/workspace-calendar.ts';

export interface SlotRules {
  /** PUB-06 : au plus N posts par compte et par jour (jour local de l'espace). */
  readonly maxPostsPerAccountPerDay: number;
  /** PUB-06 : écart minimal, en minutes, entre deux posts de l'espace (0 = aucun). */
  readonly minGapMinutesInWorkspace: number;
  /**
   * RÈG-08 : au plus N posts de l'espace au même instant. Avec l'écart minimal par
   * défaut (30 min), cette règle n'a pas d'effet ; elle sert si l'écart est mis à 0.
   */
  readonly maxWorkspacePostsPerSlot: number;
}

export const DEFAULT_SLOT_RULES: SlotRules = {
  maxPostsPerAccountPerDay: 2,
  minGapMinutesInWorkspace: 30,
  maxWorkspacePostsPerSlot: 2,
};

/** Un post de l'espace qui occupe un créneau (statuts `SLOT_OCCUPYING_STATUSES`). */
export interface OccupiedSlot {
  readonly postId: string;
  readonly accountId: string;
  readonly at: Date;
}

export interface SlotContext {
  readonly calendar: WorkspaceCalendar;
  readonly rules: SlotRules;
  /** Posts de l'espace qui occupent déjà un créneau. */
  readonly occupied: readonly OccupiedSlot[];
}

export type SlotConflict =
  /** RÈG-03 : le compte a déjà un post à cet instant. */
  | 'same_account_same_slot'
  /** PUB-06 : le compte a déjà atteint son maximum de posts ce jour-là. */
  | 'account_daily_cap'
  /** PUB-06 : un autre post de l'espace part moins de N minutes avant ou après. */
  | 'workspace_min_gap'
  /** RÈG-08 : trop de posts de l'espace au même instant. */
  | 'workspace_slot_cap';

/** Délai minimal d'un créneau choisi à la main (RÈG-04). */
export const MANUAL_SLOT_MIN_LEAD_MINUTES = 15;
/** Seuil de RÈG-14 : une reprise garde son créneau s'il est à plus de 3 heures. */
export const REWORK_KEEP_SLOT_MIN_HOURS = 3;
/** RÈG-14 : une reprise cherche un créneau sur 2 semaines. */
export const REWORK_SEARCH_DAYS = 14;
/** Horizon de recherche d'un nouveau créneau pour un post validé en retard. */
export const OVERDUE_SEARCH_DAYS = 28;

/**
 * Conflits d'un créneau candidat pour un compte. `ignorePostId` retire de l'occupation
 * le post que l'on déplace (ou celui qu'une reprise remplace).
 */
export function slotConflicts(
  candidate: Date,
  accountId: string,
  context: SlotContext,
  ignorePostId?: string,
): SlotConflict[] {
  const { rules, calendar } = context;
  const others = context.occupied.filter((slot) => slot.postId !== ignorePostId);
  const t = candidate.getTime();
  const day = localDate(candidate, calendar);
  const conflicts: SlotConflict[] = [];

  const sameAccount = others.filter((slot) => slot.accountId === accountId);
  if (sameAccount.some((slot) => slot.at.getTime() === t)) conflicts.push('same_account_same_slot');
  if (sameAccount.filter((slot) => localDate(slot.at, calendar) === day).length >= rules.maxPostsPerAccountPerDay) {
    conflicts.push('account_daily_cap');
  }

  const gapMs = rules.minGapMinutesInWorkspace * 60_000;
  if (gapMs > 0 && others.some((slot) => Math.abs(slot.at.getTime() - t) < gapMs)) {
    conflicts.push('workspace_min_gap');
  }
  if (others.filter((slot) => slot.at.getTime() === t).length >= rules.maxWorkspacePostsPerSlot) {
    conflicts.push('workspace_slot_cap');
  }
  return conflicts;
}

export function isSlotFree(candidate: Date, accountId: string, context: SlotContext, ignorePostId?: string): boolean {
  return slotConflicts(candidate, accountId, context, ignorePostId).length === 0;
}

/** Premier créneau de la grille, autorisé et libre pour ce compte, dans [from, until[. */
export function firstFreeSlot(
  accountId: string,
  from: Date,
  until: Date,
  context: SlotContext,
  ignorePostId?: string,
): Date | null {
  for (const candidate of allowedSlots(from, until, context.calendar)) {
    if (isSlotFree(candidate, accountId, context, ignorePostId)) return candidate;
  }
  return null;
}

export type ManualSlotCheck =
  | { readonly ok: true; readonly outsideAllowedHours: boolean }
  | { readonly ok: false; readonly errors: readonly (SlotConflict | 'too_soon')[] };

/**
 * Créneau choisi à la main par une personne (VAL-02 « changer la date et l'heure », RÈG-04).
 * Il doit être à 15 minutes au moins dans le futur et libre. Hors des plages autorisées,
 * il reste possible (ex. événement en soirée) mais l'interface doit le signaler.
 */
export function checkManualSlot(
  candidate: Date,
  accountId: string,
  now: Date,
  context: SlotContext,
  postId?: string,
): ManualSlotCheck {
  const errors: (SlotConflict | 'too_soon')[] = [];
  if (candidate.getTime() < addMinutes(now, MANUAL_SLOT_MIN_LEAD_MINUTES).getTime()) errors.push('too_soon');
  errors.push(...slotConflicts(candidate, accountId, context, postId));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, outsideAllowedHours: !isWithinAllowedHours(candidate, context.calendar) };
}

/** Post dont on cherche le créneau. */
export interface SchedulablePost {
  readonly postId: string;
  readonly accountId: string;
  readonly scheduledAt: Date;
  /** Date limite d'un post lié à un événement (RÈG-11) : il ne part jamais après. */
  readonly mustPublishBy?: Date;
}

export type SlotDecision =
  /** Le créneau actuel convient. */
  | { readonly kind: 'keep'; readonly at: Date }
  /** RÈG-06 : départ immédiat (la file de publication le prend dans les 5 minutes). */
  | { readonly kind: 'depart_now'; readonly at: Date }
  /** Nouveau créneau. */
  | { readonly kind: 'move'; readonly at: Date }
  /** Aucun créneau possible : le post doit passer « abandonne » avec ce motif. */
  | { readonly kind: 'abandon'; readonly reason: 'evenement_passe' | 'plus_de_creneau' };

function tooLate(post: SchedulablePost, at: Date): boolean {
  return post.mustPublishBy !== undefined && at.getTime() > post.mustPublishBy.getTime();
}

/**
 * Quand part un post validé ?
 * - Créneau encore à venir : on le garde.
 * - RÈG-06 : créneau passé (validation tardive) ; s'il est encore dans la même semaine
 *   que le créneau et dans les plages autorisées, départ immédiat ; sinon prochain
 *   créneau autorisé et libre.
 * - RÈG-22 : même calcul à la reconnexion d'un compte resté déconnecté.
 * - RÈG-11 : jamais après la date de l'événement.
 */
export function departureForValidatedPost(post: SchedulablePost, now: Date, context: SlotContext): SlotDecision {
  if (post.scheduledAt.getTime() > now.getTime()) return { kind: 'keep', at: post.scheduledAt };
  if (tooLate(post, now)) return { kind: 'abandon', reason: 'evenement_passe' };

  const canLeaveNow =
    sameIsoWeek(post.scheduledAt, now, context.calendar) &&
    isWithinAllowedHours(now, context.calendar) &&
    isSlotFree(now, post.accountId, context, post.postId);
  if (canLeaveNow) return { kind: 'depart_now', at: now };

  const next = firstFreeSlot(
    post.accountId,
    now,
    addMinutes(now, OVERDUE_SEARCH_DAYS * 24 * 60),
    context,
    post.postId,
  );
  if (next === null) return { kind: 'abandon', reason: 'plus_de_creneau' };
  if (tooLate(post, next)) return { kind: 'abandon', reason: 'evenement_passe' };
  return { kind: 'move', at: next };
}

/**
 * Créneau d'une reprise (RÈG-14) : elle garde le créneau du post qu'elle remplace s'il
 * est à plus de 3 heures ; sinon elle prend le prochain créneau libre sur 2 semaines.
 *
 * Interprétation retenue (le cahier ne précise pas le point de départ) : la recherche
 * commence à maintenant + 3 heures, pour laisser au titulaire le temps de valider,
 * ce qui est l'objet du seuil de 3 heures.
 */
export function slotForRework(replaced: SchedulablePost, now: Date, context: SlotContext): SlotDecision {
  const keepThreshold = addMinutes(now, REWORK_KEEP_SLOT_MIN_HOURS * 60);
  if (tooLate(replaced, keepThreshold)) return { kind: 'abandon', reason: 'evenement_passe' };

  if (
    replaced.scheduledAt.getTime() > keepThreshold.getTime() &&
    isSlotFree(replaced.scheduledAt, replaced.accountId, context, replaced.postId)
  ) {
    return { kind: 'keep', at: replaced.scheduledAt };
  }

  const next = firstFreeSlot(
    replaced.accountId,
    keepThreshold,
    addMinutes(now, REWORK_SEARCH_DAYS * 24 * 60),
    context,
    replaced.postId,
  );
  if (next === null) return { kind: 'abandon', reason: 'plus_de_creneau' };
  if (tooLate(replaced, next)) return { kind: 'abandon', reason: 'evenement_passe' };
  return { kind: 'move', at: next };
}

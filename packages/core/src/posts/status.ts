/**
 * Cycle de vie d'un post (cahier des charges, section 6.1).
 *
 * Toute transition passe par `applyPostCommand`. Une commande exprime une intention
 * (« valider », « refuser »…), jamais un statut cible arbitraire : une transition
 * non prévue ici est refusée, comme l'exige le cahier (« les transitions non listées
 * sont refusées par l'API »).
 */

export const POST_STATUSES = [
  'brouillon',
  'a_valider',
  'modif',
  'refuse',
  'valide',
  'en_publication',
  'publie',
  'erreur',
  'remplace',
  'abandonne',
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

/** Statuts définitifs : aucune commande ne peut en faire sortir un post. */
export const FINAL_STATUSES: ReadonlySet<PostStatus> = new Set<PostStatus>(['publie', 'remplace']);

/**
 * Statuts qui occupent un créneau : deux posts d'un même compte dans ces statuts ne
 * peuvent pas avoir le même créneau (RÈG-03, index `posts_one_per_slot`).
 */
export const SLOT_OCCUPYING_STATUSES: ReadonlySet<PostStatus> = new Set<PostStatus>([
  'a_valider',
  'valide',
  'en_publication',
  'publie',
]);

/** Motifs de refus proposés au titulaire (VAL-02). « autre » exige une précision. */
export const REFUSAL_REASONS = {
  sujet_non_pertinent: 'Sujet non pertinent pour ce compte',
  information_inexacte: 'Information inexacte ou invérifiable',
  ton_inadapte: 'Ton ou style inadapté',
  sujet_sensible: 'Sujet sensible ou confidentiel',
  deja_traite: 'Sujet déjà traité récemment',
  mauvais_moment: 'Mauvais moment (actualité, calendrier)',
  autre: 'Autre (à préciser)',
} as const;

export type RefusalReason = keyof typeof REFUSAL_REASONS;

/** Motifs d'abandon (statut « abandonne »). */
export const ABANDON_REASONS = {
  trop_de_replanifications: 'Plus de 5 replanifications sans validation (RÈG-10)',
  evenement_passe: "L'événement annoncé est passé (RÈG-11)",
  trop_de_reprises: '3 reprises refusées (GEN-07)',
  plus_de_creneau: 'Aucun créneau libre disponible',
  compte_deconnecte: 'Compte LinkedIn déconnecté (LNK-05)',
  manuel: 'Abandon décidé par un administrateur',
} as const;

export type AbandonReason = keyof typeof ABANDON_REASONS;

/**
 * Qui agit.
 * - `system` : tâches de fond (génération, publication, replanification).
 * - `user` : une personne, décrite par son lien avec le compte LinkedIn du post
 *   (titulaire, validateur délégué ou aucun) et par son rôle dans l'espace
 *   (`isWorkspaceManager` = propriétaire ou administrateur).
 *
 * Les droits génériques du rôle (éditeur, contributeur…) sont vérifiés en amont ;
 * ce module ne tranche que ce qui dépend du cycle de vie.
 */
export type Actor =
  | { readonly kind: 'system' }
  | {
      readonly kind: 'user';
      readonly userId: string;
      readonly accountRelation: 'holder' | 'delegate' | 'none';
      readonly isWorkspaceManager: boolean;
    };

/**
 * Autorités utilisées par la table des transitions.
 * - `decider` : le titulaire du compte ou un validateur délégué (ROL-01).
 * - `manager` : propriétaire ou administrateur de l'espace.
 */
type Authority = 'system' | 'decider' | 'manager';

function authoritiesOf(actor: Actor): ReadonlySet<Authority> {
  if (actor.kind === 'system') return new Set<Authority>(['system']);
  const set = new Set<Authority>();
  if (actor.accountRelation !== 'none') set.add('decider');
  if (actor.isWorkspaceManager) set.add('manager');
  return set;
}

export type PostCommand =
  /** Le brouillon (texte + visuel) est prêt : il est soumis au titulaire. */
  | { readonly type: 'submit' }
  /** VAL-02 : valider. Impossible tant qu'il reste un marqueur bloquant (VAL-03). */
  | { readonly type: 'validate' }
  /** VAL-02 : demander une modification, note obligatoire. */
  | { readonly type: 'requestChanges'; readonly note: string }
  /** VAL-02 : refuser, motif obligatoire ; « autre » exige une précision. */
  | { readonly type: 'refuse'; readonly reason: RefusalReason; readonly details?: string }
  /** VAL-08 : retirer un post validé tant qu'il n'est pas parti. */
  | { readonly type: 'withdraw'; readonly reason?: string }
  /** File de publication : l'envoi à LinkedIn commence. */
  | { readonly type: 'startPublishing' }
  /** LinkedIn a confirmé la publication. */
  | { readonly type: 'markPublished' }
  /** PUB-04 : échec après les nouvelles tentatives automatiques. */
  | { readonly type: 'markFailed'; readonly message: string }
  /** PUB-04 : bouton « réessayer ». */
  | { readonly type: 'retry' }
  /** Après une erreur, remettre le post en validation (ex. pour corriger le texte). */
  | { readonly type: 'backToReview' }
  /** Une reprise ou un autre post prend sa place (GEN-03, GEN-07). */
  | { readonly type: 'replace' }
  /** Sortie du circuit, avec un motif. */
  | { readonly type: 'abandon'; readonly reason: AbandonReason; readonly details?: string }
  /** Réactivation d'un post abandonné par un administrateur. */
  | { readonly type: 'reactivate' };

export type PostCommandType = PostCommand['type'];

interface TransitionRule {
  readonly from: readonly PostStatus[];
  readonly to: PostStatus;
  readonly by: readonly Authority[];
}

/**
 * Table des transitions. Elle reprend la section 6.1 du cahier, plus deux transitions
 * que le tableau oubliait mais que ses règles exigent :
 * - a_valider → abandonne (RÈG-10 : plus de 5 replanifications ; RÈG-11 : événement passé) ;
 * - valide → abandonne (RÈG-22 + RÈG-11 : compte resté déconnecté jusqu'après l'événement).
 */
export const TRANSITIONS: Readonly<Record<PostCommandType, TransitionRule>> = {
  submit: { from: ['brouillon'], to: 'a_valider', by: ['system'] },
  validate: { from: ['a_valider'], to: 'valide', by: ['decider'] },
  requestChanges: { from: ['a_valider'], to: 'modif', by: ['decider'] },
  refuse: { from: ['a_valider'], to: 'refuse', by: ['decider'] },
  withdraw: { from: ['valide'], to: 'a_valider', by: ['decider', 'manager', 'system'] },
  startPublishing: { from: ['valide'], to: 'en_publication', by: ['system'] },
  markPublished: { from: ['en_publication'], to: 'publie', by: ['system'] },
  markFailed: { from: ['en_publication'], to: 'erreur', by: ['system'] },
  retry: { from: ['erreur'], to: 'en_publication', by: ['decider', 'manager'] },
  backToReview: { from: ['erreur'], to: 'a_valider', by: ['decider', 'manager'] },
  replace: { from: ['a_valider', 'modif', 'refuse'], to: 'remplace', by: ['system'] },
  abandon: {
    from: ['brouillon', 'a_valider', 'modif', 'refuse', 'valide'],
    to: 'abandonne',
    by: ['system', 'manager'],
  },
  reactivate: { from: ['abandonne'], to: 'a_valider', by: ['manager'] },
};

/** Ce que le moteur doit savoir du post pour décider. */
export interface PostSnapshot {
  readonly status: PostStatus;
  /** Le texte courant contient-il [À COMPLÉTER] ou [À VÉRIFIER] ? (VAL-03) */
  readonly hasBlockingMarkers: boolean;
}

/** Ligne de `post_status_history` : toute transition est enregistrée. */
export interface StatusChange {
  readonly from: PostStatus;
  readonly to: PostStatus;
  readonly actor: Actor;
  readonly at: Date;
  readonly reason: string | null;
}

/** Décision du titulaire ou de son délégué (colonnes `decided_*` de `posts`). */
export interface Decision {
  readonly decidedBy: string;
  readonly decidedAt: Date;
  /** true si la personne a validé à la place du titulaire (ROL-01). */
  readonly asDelegate: boolean;
  readonly note: string | null;
}

export type CommandError =
  /** Le statut actuel ne permet pas cette commande. */
  | 'transition_not_allowed'
  /** La personne n'a pas l'autorité requise (ex. éditeur non délégué qui valide). */
  | 'actor_not_allowed'
  /** VAL-03 : marqueur [À COMPLÉTER] ou [À VÉRIFIER] encore présent. */
  | 'blocking_markers'
  /** VAL-02 : note obligatoire pour une demande de modification. */
  | 'note_required'
  /** VAL-02 : précision obligatoire pour le motif « autre ». */
  | 'details_required'
  /** Message d'erreur LinkedIn manquant. */
  | 'message_required';

export type CommandResult =
  | {
      readonly ok: true;
      readonly status: PostStatus;
      readonly change: StatusChange;
      readonly decision: Decision | null;
    }
  | { readonly ok: false; readonly error: CommandError };

const DECISION_COMMANDS: ReadonlySet<PostCommandType> = new Set<PostCommandType>([
  'validate',
  'requestChanges',
  'refuse',
]);

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function guard(post: PostSnapshot, command: PostCommand): CommandError | null {
  switch (command.type) {
    case 'validate':
      return post.hasBlockingMarkers ? 'blocking_markers' : null;
    case 'requestChanges':
      return nonEmpty(command.note) ? null : 'note_required';
    case 'refuse':
      return command.reason === 'autre' && !nonEmpty(command.details) ? 'details_required' : null;
    case 'markFailed':
      return nonEmpty(command.message) ? null : 'message_required';
    default:
      return null;
  }
}

function reasonOf(command: PostCommand): string | null {
  switch (command.type) {
    case 'requestChanges':
      return command.note.trim();
    case 'refuse':
      return nonEmpty(command.details) ? `${command.reason} : ${command.details.trim()}` : command.reason;
    case 'abandon':
      return nonEmpty(command.details) ? `${command.reason} : ${command.details.trim()}` : command.reason;
    case 'markFailed':
      return command.message.trim();
    case 'withdraw':
      return nonEmpty(command.reason) ? command.reason.trim() : null;
    default:
      return null;
  }
}

/**
 * Applique une commande à un post. Fonction pure : elle ne modifie rien, elle dit
 * quel est le nouveau statut, quelle ligne d'historique écrire et, pour une décision
 * du titulaire, quoi enregistrer dans `decided_*`.
 *
 * L'ordre des contrôles est délibéré : statut, puis autorité, puis contenu. Ainsi un
 * éditeur non délégué reçoit « actor_not_allowed » plutôt qu'un message sur le texte.
 */
export function applyPostCommand(
  post: PostSnapshot,
  command: PostCommand,
  actor: Actor,
  at: Date,
): CommandResult {
  const rule = TRANSITIONS[command.type];

  if (!rule.from.includes(post.status)) return { ok: false, error: 'transition_not_allowed' };

  const authorities = authoritiesOf(actor);
  if (!rule.by.some((authority) => authorities.has(authority))) {
    return { ok: false, error: 'actor_not_allowed' };
  }

  const error = guard(post, command);
  if (error !== null) return { ok: false, error };

  const reason = reasonOf(command);
  const change: StatusChange = { from: post.status, to: rule.to, actor, at, reason };

  let decision: Decision | null = null;
  if (DECISION_COMMANDS.has(command.type) && actor.kind === 'user') {
    decision = {
      decidedBy: actor.userId,
      decidedAt: at,
      asDelegate: actor.accountRelation === 'delegate',
      note: reason,
    };
  }

  return { ok: true, status: rule.to, change, decision };
}

/** Commandes possibles pour cet acteur sur ce post (pour n'afficher que les bons boutons). */
export function availableCommands(post: PostSnapshot, actor: Actor): PostCommandType[] {
  const authorities = authoritiesOf(actor);
  return (Object.keys(TRANSITIONS) as PostCommandType[]).filter((type) => {
    const rule = TRANSITIONS[type];
    return rule.from.includes(post.status) && rule.by.some((authority) => authorities.has(authority));
  });
}

/** Statuts dans lesquels le texte peut encore être corrigé (VAL-08 : pas après le départ). */
const EDITABLE_STATUSES: ReadonlySet<PostStatus> = new Set<PostStatus>([
  'brouillon',
  'a_valider',
  'modif',
  'valide',
  'erreur',
]);

export type TextEditOutcome =
  | { readonly allowed: false }
  /** La correction est enregistrée ; le statut ne change pas. */
  | { readonly allowed: true; readonly statusChange: null }
  /** RÈG-07 : correction d'un post validé par quelqu'un qui n'est ni titulaire ni délégué. */
  | { readonly allowed: true; readonly statusChange: StatusChange };

/**
 * Correction du texte d'un post (une « révision », GEN-07).
 * RÈG-07 : un post validé puis corrigé reste validé si la correction vient du
 * titulaire ou d'un délégué ; sinon il repasse « à valider ».
 * Le droit de corriger (rôle éditeur, admin, titulaire) est vérifié en amont.
 */
export function onTextEdited(post: PostSnapshot, actor: Actor, at: Date): TextEditOutcome {
  if (!EDITABLE_STATUSES.has(post.status)) return { allowed: false };

  const editedByOutsider = actor.kind === 'user' && actor.accountRelation === 'none';
  if (post.status === 'valide' && editedByOutsider) {
    return {
      allowed: true,
      statusChange: {
        from: 'valide',
        to: 'a_valider',
        actor,
        at,
        reason: 'Texte corrigé par une personne non déléguée : nouvelle validation nécessaire (RÈG-07)',
      },
    };
  }
  return { allowed: true, statusChange: null };
}

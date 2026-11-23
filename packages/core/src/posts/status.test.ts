import { describe, expect, it } from 'vitest';
import {
  type Actor,
  type PostCommand,
  type PostStatus,
  FINAL_STATUSES,
  POST_STATUSES,
  TRANSITIONS,
  applyPostCommand,
  availableCommands,
  onTextEdited,
} from './status.ts';

const at = new Date('2026-11-17T11:00:00Z');
const system: Actor = { kind: 'system' };
const holder: Actor = { kind: 'user', userId: 'jp', accountRelation: 'holder', isWorkspaceManager: false };
const delegate: Actor = { kind: 'user', userId: 'alice', accountRelation: 'delegate', isWorkspaceManager: false };
const editor: Actor = { kind: 'user', userId: 'alexis', accountRelation: 'none', isWorkspaceManager: false };
const admin: Actor = { kind: 'user', userId: 'admin', accountRelation: 'none', isWorkspaceManager: true };

const post = (status: PostStatus, hasBlockingMarkers = false) => ({ status, hasBlockingMarkers });

/** Une commande valide de chaque type, pour les tests exhaustifs. */
const SAMPLE_COMMANDS: Record<PostCommand['type'], PostCommand> = {
  submit: { type: 'submit' },
  validate: { type: 'validate' },
  autoValidate: { type: 'autoValidate' },
  requestChanges: { type: 'requestChanges', note: 'Raccourcir le 2e paragraphe' },
  refuse: { type: 'refuse', reason: 'deja_traite' },
  withdraw: { type: 'withdraw' },
  startPublishing: { type: 'startPublishing' },
  markPublished: { type: 'markPublished' },
  markFailed: { type: 'markFailed', message: 'HTTP 500' },
  retry: { type: 'retry' },
  backToReview: { type: 'backToReview' },
  replace: { type: 'replace' },
  abandon: { type: 'abandon', reason: 'manuel' },
  reactivate: { type: 'reactivate' },
};

/** Un acteur qui a l'autorité requise par la règle, pour isoler le contrôle du statut. */
function authorizedActorFor(type: PostCommand['type']): Actor {
  const by = TRANSITIONS[type].by;
  if (by.includes('system')) return system;
  if (by.includes('decider')) return holder;
  return admin;
}

describe('cycle de vie d’un post (6.1)', () => {
  it('refuse toute transition non listée, pour chaque commande et chaque statut', () => {
    for (const [type, command] of Object.entries(SAMPLE_COMMANDS) as [PostCommand['type'], PostCommand][]) {
      for (const status of POST_STATUSES) {
        const result = applyPostCommand(post(status), command, authorizedActorFor(type), at);
        if (TRANSITIONS[type].from.includes(status)) {
          expect(result.ok, `${type} depuis ${status}`).toBe(true);
        } else {
          expect(result, `${type} depuis ${status}`).toEqual({ ok: false, error: 'transition_not_allowed' });
        }
      }
    }
  });

  it('ne laisse sortir aucun post d’un statut final', () => {
    for (const status of FINAL_STATUSES) {
      for (const actor of [system, holder, admin]) {
        expect(availableCommands(post(status), actor)).toEqual([]);
      }
    }
  });

  it('laisse chaque statut non final avec au moins une sortie', () => {
    for (const status of POST_STATUSES.filter((s) => !FINAL_STATUSES.has(s))) {
      const exits = Object.values(TRANSITIONS).filter((rule) => rule.from.includes(status));
      expect(exits.length, status).toBeGreaterThan(0);
    }
  });

  it('VAL-11 : la validation automatique est réservée au système et respecte les marqueurs', () => {
    expect(applyPostCommand(post('a_valider'), { type: 'autoValidate' }, system, at)).toMatchObject({ ok: true, status: 'valide', decision: null });
    expect(applyPostCommand(post('a_valider'), { type: 'autoValidate' }, holder, at)).toEqual({ ok: false, error: 'actor_not_allowed' });
    expect(applyPostCommand(post('a_valider', true), { type: 'autoValidate' }, system, at)).toEqual({ ok: false, error: 'blocking_markers' });
  });

  it('enregistre la transition (ancien statut, nouveau, acteur, date, motif)', () => {
    const result = applyPostCommand(post('a_valider'), { type: 'requestChanges', note: '  Ajouter la date  ' }, holder, at);
    expect(result).toMatchObject({
      ok: true,
      status: 'modif',
      change: { from: 'a_valider', to: 'modif', actor: holder, at, reason: 'Ajouter la date' },
    });
  });
});

describe('validation (VAL-02, VAL-03, ROL-01)', () => {
  it('le titulaire valide ; la décision n’est pas une délégation', () => {
    const result = applyPostCommand(post('a_valider'), { type: 'validate' }, holder, at);
    expect(result).toMatchObject({
      ok: true,
      status: 'valide',
      decision: { decidedBy: 'jp', decidedAt: at, asDelegate: false },
    });
  });

  it('un délégué valide ; la décision est marquée comme délégation', () => {
    const result = applyPostCommand(post('a_valider'), { type: 'validate' }, delegate, at);
    expect(result).toMatchObject({ ok: true, decision: { decidedBy: 'alice', asDelegate: true } });
  });

  it('un éditeur ou un admin non délégué ne peut pas valider (« si délégué »)', () => {
    for (const actor of [editor, admin]) {
      expect(applyPostCommand(post('a_valider'), { type: 'validate' }, actor, at)).toEqual({
        ok: false,
        error: 'actor_not_allowed',
      });
    }
  });

  it('un admin délégué peut valider', () => {
    const adminDelegate: Actor = { kind: 'user', userId: 'admin', accountRelation: 'delegate', isWorkspaceManager: true };
    expect(applyPostCommand(post('a_valider'), { type: 'validate' }, adminDelegate, at).ok).toBe(true);
  });

  it('le système ne peut jamais valider à la place d’une personne', () => {
    expect(applyPostCommand(post('a_valider'), { type: 'validate' }, system, at)).toEqual({
      ok: false,
      error: 'actor_not_allowed',
    });
  });

  it('refuse la validation tant qu’un marqueur bloquant est présent', () => {
    expect(applyPostCommand(post('a_valider', true), { type: 'validate' }, holder, at)).toEqual({
      ok: false,
      error: 'blocking_markers',
    });
  });

  it('exige une note non vide pour demander une modification', () => {
    for (const note of ['', '   ']) {
      expect(applyPostCommand(post('a_valider'), { type: 'requestChanges', note }, holder, at)).toEqual({
        ok: false,
        error: 'note_required',
      });
    }
  });

  it('accepte un refus avec un motif de la liste, sans précision', () => {
    const result = applyPostCommand(post('a_valider'), { type: 'refuse', reason: 'ton_inadapte' }, holder, at);
    expect(result).toMatchObject({ ok: true, status: 'refuse', change: { reason: 'ton_inadapte' } });
  });

  it('exige une précision pour le motif « autre »', () => {
    expect(applyPostCommand(post('a_valider'), { type: 'refuse', reason: 'autre' }, holder, at)).toEqual({
      ok: false,
      error: 'details_required',
    });
    const result = applyPostCommand(
      post('a_valider'),
      { type: 'refuse', reason: 'autre', details: 'Client pas encore annoncé' },
      holder,
      at,
    );
    expect(result).toMatchObject({ ok: true, change: { reason: 'autre : Client pas encore annoncé' } });
  });

  it('propose au titulaire exactement : valider, demander une modification, refuser', () => {
    expect(availableCommands(post('a_valider'), holder).sort()).toEqual(['refuse', 'requestChanges', 'validate']);
  });

  it('ne propose aucune décision à un éditeur non délégué', () => {
    expect(availableCommands(post('a_valider'), editor)).toEqual([]);
  });
});

describe('publication, erreurs, abandon', () => {
  it('suit le chemin nominal valide → en_publication → publie', () => {
    const start = applyPostCommand(post('valide'), { type: 'startPublishing' }, system, at);
    expect(start).toMatchObject({ ok: true, status: 'en_publication' });
    const done = applyPostCommand(post('en_publication'), { type: 'markPublished' }, system, at);
    expect(done).toMatchObject({ ok: true, status: 'publie', decision: null });
  });

  it('exige le message LinkedIn pour passer en erreur (PUB-04)', () => {
    expect(applyPostCommand(post('en_publication'), { type: 'markFailed', message: ' ' }, system, at)).toEqual({
      ok: false,
      error: 'message_required',
    });
  });

  it('laisse le titulaire et l’admin réessayer après une erreur, pas un éditeur', () => {
    expect(applyPostCommand(post('erreur'), { type: 'retry' }, holder, at).ok).toBe(true);
    expect(applyPostCommand(post('erreur'), { type: 'retry' }, admin, at).ok).toBe(true);
    expect(applyPostCommand(post('erreur'), { type: 'retry' }, editor, at)).toEqual({
      ok: false,
      error: 'actor_not_allowed',
    });
  });

  it('permet d’abandonner un post à valider (RÈG-10, RÈG-11), absent du tableau 6.1 de la v1.1', () => {
    const result = applyPostCommand(post('a_valider'), { type: 'abandon', reason: 'trop_de_replanifications' }, system, at);
    expect(result).toMatchObject({ ok: true, status: 'abandonne', change: { reason: 'trop_de_replanifications' } });
  });

  it('permet d’abandonner un post validé dont l’événement est passé (RÈG-22 + RÈG-11)', () => {
    const result = applyPostCommand(post('valide'), { type: 'abandon', reason: 'evenement_passe' }, system, at);
    expect(result).toMatchObject({ ok: true, status: 'abandonne' });
  });

  it('réserve la réactivation d’un post abandonné à un administrateur', () => {
    expect(applyPostCommand(post('abandonne'), { type: 'reactivate' }, admin, at).ok).toBe(true);
    expect(applyPostCommand(post('abandonne'), { type: 'reactivate' }, holder, at)).toEqual({
      ok: false,
      error: 'actor_not_allowed',
    });
  });
});

describe('correction du texte (RÈG-07, VAL-08)', () => {
  it('garde le post validé si le titulaire ou un délégué corrige', () => {
    expect(onTextEdited(post('valide'), holder, at)).toEqual({ allowed: true, statusChange: null });
    expect(onTextEdited(post('valide'), delegate, at)).toEqual({ allowed: true, statusChange: null });
  });

  it('repasse le post « à valider » si un éditeur non délégué corrige', () => {
    expect(onTextEdited(post('valide'), editor, at)).toMatchObject({
      allowed: true,
      statusChange: { from: 'valide', to: 'a_valider', actor: editor },
    });
  });

  it('ne change rien au statut quand le post n’était pas encore validé', () => {
    expect(onTextEdited(post('a_valider'), editor, at)).toEqual({ allowed: true, statusChange: null });
  });

  it('interdit toute correction une fois l’envoi commencé ou le post sorti du circuit', () => {
    for (const status of ['en_publication', 'publie', 'remplace', 'abandonne', 'refuse'] as const) {
      expect(onTextEdited(post(status), holder, at), status).toEqual({ allowed: false });
    }
  });
});

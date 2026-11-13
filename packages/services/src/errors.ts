/**
 * Erreurs des actions métier, traduites ensuite en réponses HTTP par l'application :
 * NotFound → 404, Forbidden → 403, Refused → 409 ou 422 selon le code.
 */

/** Introuvable, ou invisible pour cette personne (la RLS ne distingue pas les deux : REC-01). */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  constructor(entity: string) {
    super(`${entity} introuvable`);
  }
}

/** Visible mais action non permise par le rôle de la personne (matrice 3.3). */
export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
  readonly action: string;
  constructor(action: string) {
    super(`Action non autorisée : ${action}`);
    this.action = action;
  }
}

/** Action refusée par une règle métier, avec un code stable pour l'interface. */
export class RefusedError extends Error {
  override readonly name = 'RefusedError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

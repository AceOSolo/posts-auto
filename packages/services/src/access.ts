/**
 * Droits d'une personne sur un compte LinkedIn d'un espace (cahier des charges, 3.2 et 3.3).
 *
 * Lus sous l'identité de la personne (RLS) : on ne peut pas se fabriquer de droits sur
 * un espace qu'on ne voit pas.
 */
import type { Actor } from '@posts-auto/core';
import type { Tx } from '@posts-auto/db';

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'contributor' | 'viewer';

export interface Access {
  readonly userId: string;
  /** Rôle effectif dans l'espace ; le propriétaire de l'organisation a tous les droits. */
  readonly role: WorkspaceRole | null;
  /** Lien avec le compte : titulaire, validateur délégué ou aucun (ROL-01). */
  readonly relation: 'holder' | 'delegate' | 'none';
  /** Acteur pour le moteur de règles. */
  readonly actor: Actor;
}

export async function loadAccess(trx: Tx, userId: string, workspaceId: string, accountId: string): Promise<Access> {
  const membership = await trx
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const ownership = await trx
    .selectFrom('org_members as o')
    .innerJoin('workspaces as w', 'w.org_id', 'o.org_id')
    .select('o.role')
    .where('w.id', '=', workspaceId)
    .where('o.user_id', '=', userId)
    .where('o.role', '=', 'owner')
    .executeTakeFirst();
  const account = await trx.selectFrom('social_accounts').select('holder_user_id').where('id', '=', accountId).executeTakeFirst();
  const delegate = await trx
    .selectFrom('account_delegates')
    .select('user_id')
    .where('account_id', '=', accountId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  const role: WorkspaceRole | null = ownership ? 'owner' : ((membership?.role as WorkspaceRole | undefined) ?? null);
  const relation = account?.holder_user_id === userId ? 'holder' : delegate ? 'delegate' : 'none';
  return {
    userId,
    role,
    relation,
    actor: { kind: 'user', userId, accountRelation: relation, isWorkspaceManager: role === 'owner' || role === 'admin' },
  };
}

/** Corriger le texte d'un post (matrice 3.3 ; VAL-02 « corriger puis valider »). */
export function canEditPost(access: Access): boolean {
  return access.role === 'owner' || access.role === 'admin' || access.role === 'editor' || access.relation !== 'none';
}

/** Changer la date et l'heure d'un post (matrice 3.3 « replanifier »). */
export const canReschedulePost = canEditPost;

/** Rôle effectif d'une personne dans un espace (lu sous RLS) ; `null` si l'espace lui est invisible ou étranger. */
export async function workspaceRole(trx: Tx, userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const workspace = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirst();
  if (workspace === undefined) return null;
  const owner = await trx
    .selectFrom('org_members')
    .select('role')
    .where('org_id', '=', workspace.org_id)
    .where('user_id', '=', userId)
    .where('role', '=', 'owner')
    .executeTakeFirst();
  if (owner !== undefined) return 'owner';
  const member = await trx
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return (member?.role as WorkspaceRole | undefined) ?? null;
}

/** Ligne éditoriale, fiches de compte, planning, génération (matrice 3.3). */
export function canManageContent(role: WorkspaceRole | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

/** Proposer une idée ou une demande de post : tout le monde, sauf les lecteurs (matrice 3.3). */
export function canPropose(role: WorkspaceRole | null): boolean {
  return role !== null && role !== 'viewer';
}

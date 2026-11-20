/**
 * Espaces de l'organisation : une agence en crée un par client (section 3.1, formule Agence).
 *
 * - Seul le propriétaire de l'organisation crée un espace ; il en devient administrateur.
 * - Nombre d'espaces : celui de la formule de l'abonnement (`plans.max_workspaces`, NULL :
 *   illimités). Sans abonnement : une entreprise a un espace, une agence en essai ou un
 *   client pilote n'est pas limité (l'essai limite déjà comptes et posts pour toute
 *   l'organisation).
 * - Chaque espace est cloisonné (RLS) : ligne éditoriale, comptes, planning et équipe propres.
 */
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { workspaceRole } from '../access.ts';
import { audit } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { workspaceDefaults } from '../admin/platform.ts';

export const WORKSPACE_NAME_MAX = 80;

export interface OrgWorkspace {
  readonly id: string;
  readonly name: string;
  readonly accounts: number;
  readonly members: number;
  readonly pendingValidation: number;
  readonly onboarded: boolean;
}

export interface OrgWorkspaces {
  readonly orgId: string;
  readonly orgName: string;
  readonly orgKind: 'entreprise' | 'agence';
  readonly canCreate: boolean;
  /** null : pas de limite. */
  readonly maxWorkspaces: number | null;
  readonly workspaces: readonly OrgWorkspace[];
}

async function ownerOrgOf(db: Database, userId: string, workspaceId: string): Promise<{ orgId: string; owner: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
    return { orgId: ws.org_id, owner: role === 'owner' };
  });
}

/** Nombre d'espaces permis à l'organisation ; null : pas de limite. */
export async function workspaceLimit(trx: Tx, orgId: string): Promise<number | null> {
  const org = await trx.selectFrom('organizations').select(['kind', 'trial_ends_at']).where('id', '=', orgId).executeTakeFirstOrThrow();
  const sub = await trx
    .selectFrom('subscriptions as s')
    .innerJoin('plans as p', 'p.key', 's.plan_key')
    .select(['s.status', 'p.max_workspaces'])
    .where('s.org_id', '=', orgId)
    .executeTakeFirst();
  if (sub !== undefined && sub.status !== 'canceled' && sub.status !== 'incomplete') return sub.max_workspaces;
  if (org.trial_ends_at === null && sub === undefined) return null; // client pilote
  return org.kind === 'agence' ? null : 1;
}

/** Page « Clients » d'une agence (ou « Espaces ») : les espaces de l'organisation, pour son propriétaire. */
export async function listOrgWorkspaces(db: Database, userId: string, workspaceId: string): Promise<OrgWorkspaces> {
  const { orgId, owner } = await ownerOrgOf(db, userId, workspaceId);
  if (!owner) throw new ForbiddenError('manageOrganization');
  return asSystem(db, async (trx) => {
    const org = await trx.selectFrom('organizations').select(['name', 'kind']).where('id', '=', orgId).executeTakeFirstOrThrow();
    const rows = await trx
      .selectFrom('workspaces as w')
      .select([
        'w.id',
        'w.name',
        'w.onboarding_done_at',
        sql<number>`(select count(*)::int from social_accounts a where a.workspace_id = w.id and a.status in ('connected', 'expiring', 'expired'))`.as('accounts'),
        sql<number>`(select count(*)::int from workspace_members m where m.workspace_id = w.id)`.as('members'),
        sql<number>`(select count(*)::int from posts p where p.workspace_id = w.id and p.status = 'a_valider')`.as('pending'),
      ])
      .where('w.org_id', '=', orgId)
      .orderBy('w.name')
      .execute();
    const max = await workspaceLimit(trx, orgId);
    return {
      orgId,
      orgName: org.name,
      orgKind: org.kind as 'entreprise' | 'agence',
      maxWorkspaces: max,
      canCreate: max === null || rows.length < max,
      workspaces: rows.map((r) => ({ id: r.id, name: r.name, accounts: r.accounts, members: r.members, pendingValidation: r.pending, onboarded: r.onboarding_done_at !== null })),
    };
  });
}

/** Nouvel espace dans l'organisation (un client de l'agence) ; renvoie son identifiant. */
export async function createWorkspace(db: Database, userId: string, fromWorkspaceId: string, rawName: string, now: Date): Promise<string> {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > WORKSPACE_NAME_MAX) throw new RefusedError('nom_espace_invalide', `Le nom doit faire entre 1 et ${WORKSPACE_NAME_MAX} caractères.`);
  const { orgId, owner } = await ownerOrgOf(db, userId, fromWorkspaceId);
  if (!owner) throw new ForbiddenError('manageOrganization');
  const created = await asSystem(db, async (trx) => {
    // Verrou sur l'organisation : deux créations simultanées ne dépassent pas la limite.
    await trx.selectFrom('organizations').select('id').where('id', '=', orgId).forUpdate().executeTakeFirstOrThrow();
    const max = await workspaceLimit(trx, orgId);
    const count = await trx.selectFrom('workspaces').select(sql<number>`count(*)::int`.as('n')).where('org_id', '=', orgId).executeTakeFirstOrThrow();
    if (max !== null && count.n >= max) throw new RefusedError('limite_espaces', `Votre formule permet ${max} espace${max > 1 ? 's' : ''}.`);
    const duplicate = await trx.selectFrom('workspaces').select('id').where('org_id', '=', orgId).where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst();
    if (duplicate !== undefined) throw new RefusedError('espace_existe', 'Un espace porte déjà ce nom.');
    const ws = await trx.insertInto('workspaces').values({ org_id: orgId, name, created_at: now, ...(await workspaceDefaults(trx)) }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('workspace_members').values({ workspace_id: ws.id, user_id: userId, role: 'admin', created_at: now }).execute();
    return ws.id;
  });
  await asUser(db, userId, (trx) => audit(trx, { workspaceId: created, actorUserId: userId, action: 'espace.cree', entity: 'workspace', entityId: created, details: { name }, at: now }));
  return created;
}

/** Organisations dont la personne est propriétaire, avec leur premier espace (navigation). */
export async function ownedOrganizations(db: Database, userId: string): Promise<{ readonly orgId: string; readonly kind: 'entreprise' | 'agence'; readonly workspaceId: string }[]> {
  return asUser(db, userId, async (trx) => {
    const rows = await trx
      .selectFrom('org_members as o')
      .innerJoin('organizations as g', 'g.id', 'o.org_id')
      .select(['o.org_id', 'g.kind', sql<string | null>`(select w.id from workspaces w where w.org_id = o.org_id order by w.created_at limit 1)`.as('workspace_id')])
      .where('o.user_id', '=', userId)
      .where('o.role', '=', 'owner')
      .execute();
    return rows.filter((r) => r.workspace_id !== null).map((r) => ({ orgId: r.org_id, kind: r.kind as 'entreprise' | 'agence', workspaceId: r.workspace_id as string }));
  });
}

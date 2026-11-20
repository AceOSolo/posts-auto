/**
 * ADM-02 : intervention du support « en tant que » un client, avec son accord et une trace
 * dans son journal d'audit.
 *
 * 1. Un administrateur ou le propriétaire de l'espace accorde l'accès, pour 1 à 72 heures
 *    (page « Réglages » de l'espace) ; il peut le retirer à tout moment.
 * 2. Une personne de l'éditeur ouvre alors une session au nom de qui a accordé l'accès, qui
 *    voit et fait ce que cette personne peut voir et faire, jusqu'à la fin de l'accord.
 * 3. L'accord, l'ouverture et la fin de la session sont inscrits au journal d'audit de
 *    l'espace (acteur « support ») ; un bandeau signale la session pendant toute sa durée.
 */
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import { type WorkspaceRole, workspaceRole } from '../access.ts';
import { type SessionGrant, hashToken, newToken } from '../auth/auth.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { requirePlatformAdmin } from './platform.ts';

export const SUPPORT_MAX_HOURS = 72;

export interface SupportGrant {
  readonly id: string;
  readonly grantedBy: string;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

async function requireManager(db: Database, userId: string, workspaceId: string): Promise<WorkspaceRole> {
  const role = await asUser(db, userId, (trx) => workspaceRole(trx, userId, workspaceId));
  if (role === null) throw new NotFoundError('Espace');
  if (role !== 'owner' && role !== 'admin') throw new ForbiddenError('grantSupport');
  return role;
}

async function supportAudit(trx: Tx, workspaceId: string, actor: { kind: 'user' | 'support'; userId: string }, action: string, details: Record<string, unknown>, at: Date): Promise<void> {
  const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
  await trx
    .insertInto('audit_log')
    .values({ org_id: ws.org_id, workspace_id: workspaceId, actor_user_id: actor.userId, actor_kind: actor.kind, action, entity: 'workspace', entity_id: workspaceId, details: JSON.stringify(details), at })
    .execute();
}

export async function grantSupportAccess(db: Database, userId: string, workspaceId: string, input: { readonly hours: number; readonly reason: string }, now: Date): Promise<string> {
  await requireManager(db, userId, workspaceId);
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > SUPPORT_MAX_HOURS) throw new RefusedError('duree_invalide', `Durée : de 1 à ${SUPPORT_MAX_HOURS} heures.`);
  const reason = input.reason.trim().slice(0, 500) || null;
  const expiresAt = new Date(now.getTime() + input.hours * 3_600_000);
  return asSystem(db, async (trx) => {
    const row = await trx.insertInto('support_grants').values({ workspace_id: workspaceId, granted_by: userId, reason, created_at: now, expires_at: expiresAt }).returning('id').executeTakeFirstOrThrow();
    await supportAudit(trx, workspaceId, { kind: 'user', userId }, 'support.acces_accorde', { grantId: row.id, hours: input.hours, reason }, now);
    return row.id;
  });
}

export async function listSupportGrants(db: Database, userId: string, workspaceId: string, now: Date): Promise<SupportGrant[]> {
  await requireManager(db, userId, workspaceId);
  const rows = await asSystem(db, (trx) =>
    trx
      .selectFrom('support_grants as g')
      .innerJoin('users as u', 'u.id', 'g.granted_by')
      .select(['g.id', 'u.email', 'g.reason', 'g.created_at', 'g.expires_at'])
      .where('g.workspace_id', '=', workspaceId)
      .where('g.revoked_at', 'is', null)
      .where('g.expires_at', '>', now)
      .orderBy('g.created_at', 'desc')
      .execute(),
  );
  return rows.map((r) => ({ id: r.id, grantedBy: r.email, reason: r.reason, createdAt: r.created_at, expiresAt: r.expires_at }));
}

/** Retire l'accès : les sessions du support ouvertes avec cet accord sont fermées. */
export async function revokeSupportAccess(db: Database, userId: string, workspaceId: string, grantId: string, now: Date): Promise<void> {
  await requireManager(db, userId, workspaceId);
  await asSystem(db, async (trx) => {
    const revoked = await trx.updateTable('support_grants').set({ revoked_at: now }).where('id', '=', grantId).where('workspace_id', '=', workspaceId).where('revoked_at', 'is', null).returning('id').executeTakeFirst();
    if (revoked === undefined) return;
    await trx.updateTable('sessions').set({ revoked_at: now }).where('support_grant_id', '=', grantId).where('revoked_at', 'is', null).execute();
    await supportAudit(trx, workspaceId, { kind: 'user', userId }, 'support.acces_retire', { grantId }, now);
  });
}

/** Ouverture d'une session du support au nom de qui a accordé l'accès. */
export async function openSupportSession(db: Database, adminId: string, grantId: string, now: Date, meta: { ip?: string; userAgent?: string } = {}): Promise<SessionGrant & { workspaceId: string }> {
  await requirePlatformAdmin(db, adminId);
  return asSystem(db, async (trx) => {
    const grant = await trx
      .selectFrom('support_grants')
      .select(['id', 'workspace_id', 'granted_by', 'expires_at'])
      .where('id', '=', grantId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    if (grant === undefined) throw new RefusedError('acces_support_expire', 'Cet accès n’est plus valable.');
    const sessionToken = newToken();
    await trx
      .insertInto('sessions')
      .values({
        user_id: grant.granted_by,
        token_hash: hashToken(sessionToken),
        created_at: now,
        last_seen_at: now,
        expires_at: grant.expires_at,
        ip: meta.ip ?? null,
        user_agent: meta.userAgent?.slice(0, 500) ?? null,
        // Le second facteur a été vérifié sur la session de la personne de l'éditeur.
        mfa_verified_at: now,
        support_admin_id: adminId,
        support_grant_id: grant.id,
      })
      .execute();
    const admin = await trx.selectFrom('users').select('email').where('id', '=', adminId).executeTakeFirstOrThrow();
    await supportAudit(trx, grant.workspace_id, { kind: 'support', userId: adminId }, 'support.session_ouverte', { grantId, by: admin.email }, now);
    return { userId: grant.granted_by, sessionToken, expiresAt: grant.expires_at, workspaceId: grant.workspace_id };
  });
}

/** Fin d'une session du support (déconnexion), inscrite au journal de l'espace. */
export async function endSupportSession(db: Database, sessionToken: string, now: Date): Promise<void> {
  await asSystem(db, async (trx) => {
    const session = await trx
      .updateTable('sessions')
      .set({ revoked_at: now })
      .where('token_hash', '=', hashToken(sessionToken))
      .where('revoked_at', 'is', null)
      .where('support_admin_id', 'is not', null)
      .returning(['support_admin_id', 'support_grant_id'])
      .executeTakeFirst();
    if (session?.support_grant_id == null || session.support_admin_id == null) return;
    const grant = await trx.selectFrom('support_grants').select('workspace_id').where('id', '=', session.support_grant_id).executeTakeFirst();
    if (grant !== undefined) await supportAudit(trx, grant.workspace_id, { kind: 'support', userId: session.support_admin_id }, 'support.session_terminee', { grantId: session.support_grant_id }, now);
  });
}

/** Accords en cours chez tous les clients (back-office). */
export async function activeSupportGrants(db: Database, adminId: string, now: Date) {
  await requirePlatformAdmin(db, adminId);
  return asSystem(db, (trx) =>
    trx
      .selectFrom('support_grants as g')
      .innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
      .innerJoin('organizations as o', 'o.id', 'w.org_id')
      .innerJoin('users as u', 'u.id', 'g.granted_by')
      .select(['g.id', 'o.id as orgId', 'o.name as orgName', 'w.name as workspaceName', 'u.email as grantedBy', 'g.reason', 'g.expires_at as expiresAt'])
      .where('g.revoked_at', 'is', null)
      .where('g.expires_at', '>', now)
      .orderBy('g.expires_at')
      .execute(),
  );
}

/**
 * Gestion d'un espace par ses administrateurs (matrice 3.3) : invitation des membres
 * (ONB-07), rôles, validateurs délégués (ROL-01), mise en pause d'un compte (LNK-07, utile
 * à la bascule compte par compte RÈG-21).
 *
 * Droits vérifiés sous l'identité de la personne ; la création d'un utilisateur, réservée
 * au système, se fait ensuite en contexte système.
 */
import { randomBytes } from 'node:crypto';
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import type { TokenEncryptor } from '../accounts/accounts.ts';
import { normalizeEmail } from '../auth/auth.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { checkPublicUrl } from '../net/safe-fetch.ts';

export type MemberRole = 'admin' | 'editor' | 'contributor' | 'viewer';
export const MEMBER_ROLES: readonly MemberRole[] = ['admin', 'editor', 'contributor', 'viewer'];

/** Propriétaire de l'organisation ou administrateur de l'espace ? (lu sous RLS) */
async function isManager(trx: Tx, userId: string, workspaceId: string): Promise<boolean> {
  const workspace = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirst();
  if (workspace === undefined) throw new NotFoundError('Espace');
  const member = await trx
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (member?.role === 'admin') return true;
  const owner = await trx
    .selectFrom('org_members')
    .select('role')
    .where('org_id', '=', workspace.org_id)
    .where('user_id', '=', userId)
    .where('role', '=', 'owner')
    .executeTakeFirst();
  return owner !== undefined;
}

async function requireManager(db: Database, userId: string, workspaceId: string, action: string): Promise<string> {
  return asUser(db, userId, async (trx) => {
    if (!(await isManager(trx, userId, workspaceId))) throw new ForbiddenError(action);
    const workspace = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
    return workspace.org_id;
  });
}

async function audit(trx: Tx, orgId: string, workspaceId: string, actor: string, action: string, entity: string, entityId: string, details: Record<string, unknown>, at: Date) {
  await trx
    .insertInto('audit_log')
    .values({ org_id: orgId, workspace_id: workspaceId, actor_user_id: actor, actor_kind: 'user', action, entity, entity_id: entityId, details: JSON.stringify(details), at })
    .execute();
}

export interface Member {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly role: MemberRole;
  readonly lastLoginAt: Date | null;
}

export async function listMembers(db: Database, userId: string, workspaceId: string): Promise<{ members: Member[]; canManage: boolean }> {
  return asUser(db, userId, async (trx) => {
    const canManage = await isManager(trx, userId, workspaceId);
    const rows = await trx
      .selectFrom('workspace_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.user_id', 'u.email', 'u.full_name', 'm.role', 'u.last_login_at'])
      .where('m.workspace_id', '=', workspaceId)
      .orderBy('u.full_name')
      .execute();
    return {
      canManage,
      members: rows.map((row) => ({ userId: row.user_id, email: row.email, fullName: row.full_name, role: row.role as MemberRole, lastLoginAt: row.last_login_at })),
    };
  });
}

export interface InvitationInput {
  readonly email: string;
  readonly fullName?: string;
  readonly role: MemberRole;
}

/**
 * ONB-07 : invite une personne dans l'espace. Crée son utilisateur s'il n'existe pas ;
 * l'application lui envoie ensuite un lien de connexion.
 */
export async function inviteMember(
  db: Database,
  userId: string,
  workspaceId: string,
  input: InvitationInput,
  now: Date,
): Promise<{ userId: string; email: string; alreadyMember: boolean }> {
  const email = normalizeEmail(input.email);
  if (email === null) throw new RefusedError('email_invalide', 'Adresse e-mail invalide.');
  if (!MEMBER_ROLES.includes(input.role)) throw new RefusedError('role_invalide', 'Rôle inconnu.');
  const orgId = await requireManager(db, userId, workspaceId, 'invite');
  const fullName = input.fullName?.trim() || null;

  return asSystem(db, async (trx) => {
    const user = await trx
      .insertInto('users')
      .values({ email, full_name: fullName })
      .onConflict((oc) => oc.column('email').doUpdateSet((eb) => ({ full_name: eb.fn.coalesce('users.full_name', eb.val(fullName)) })))
      .returning('id')
      .executeTakeFirstOrThrow();
    const existing = await trx
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (existing === undefined) {
      await trx.insertInto('workspace_members').values({ workspace_id: workspaceId, user_id: user.id, role: input.role }).execute();
    }
    await audit(trx, orgId, workspaceId, userId, 'membre.invite', 'user', user.id, { role: input.role, alreadyMember: existing !== undefined }, now);
    return { userId: user.id, email, alreadyMember: existing !== undefined };
  });
}

/** Le dernier administrateur d'un espace ne peut pas perdre son rôle (sauf par le propriétaire). */
async function adminCount(trx: Tx, workspaceId: string): Promise<number> {
  const row = await trx
    .selectFrom('workspace_members')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('workspace_id', '=', workspaceId)
    .where('role', '=', 'admin')
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function changeMemberRole(db: Database, userId: string, workspaceId: string, memberId: string, role: MemberRole, now: Date): Promise<void> {
  if (!MEMBER_ROLES.includes(role)) throw new RefusedError('role_invalide', 'Rôle inconnu.');
  const orgId = await requireManager(db, userId, workspaceId, 'changeRole');
  await asUser(db, userId, async (trx) => {
    const current = await trx
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', memberId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw new NotFoundError('Membre');
    if (current.role === 'admin' && role !== 'admin' && (await adminCount(trx, workspaceId)) <= 1) {
      throw new RefusedError('dernier_admin', 'L’espace doit garder au moins un administrateur.');
    }
    await trx.updateTable('workspace_members').set({ role }).where('workspace_id', '=', workspaceId).where('user_id', '=', memberId).execute();
    await audit(trx, orgId, workspaceId, userId, 'membre.role', 'user', memberId, { from: current.role, to: role }, now);
  });
}

/** Retire une personne de l'espace, et de ses délégations sur les comptes de l'espace. */
export async function removeMember(db: Database, userId: string, workspaceId: string, memberId: string, now: Date): Promise<void> {
  const orgId = await requireManager(db, userId, workspaceId, 'removeMember');
  await asUser(db, userId, async (trx) => {
    const current = await trx.selectFrom('workspace_members').select('role').where('workspace_id', '=', workspaceId).where('user_id', '=', memberId).executeTakeFirst();
    if (current === undefined) throw new NotFoundError('Membre');
    if (current.role === 'admin' && (await adminCount(trx, workspaceId)) <= 1) {
      throw new RefusedError('dernier_admin', 'L’espace doit garder au moins un administrateur.');
    }
    await trx.deleteFrom('account_delegates').where('workspace_id', '=', workspaceId).where('user_id', '=', memberId).execute();
    await trx.deleteFrom('workspace_members').where('workspace_id', '=', workspaceId).where('user_id', '=', memberId).execute();
    await audit(trx, orgId, workspaceId, userId, 'membre.retire', 'user', memberId, { role: current.role }, now);
  });
}

/** ROL-01 : l'administrateur choisit qui peut valider à la place du titulaire. */
export async function setDelegates(db: Database, userId: string, accountId: string, delegateIds: readonly string[], now: Date): Promise<void> {
  const unique = [...new Set(delegateIds)];
  await asUser(db, userId, async (trx) => {
    const account = await trx.selectFrom('social_accounts').select(['workspace_id', 'holder_user_id']).where('id', '=', accountId).executeTakeFirst();
    if (account === undefined) throw new NotFoundError('Compte');
    if (!(await isManager(trx, userId, account.workspace_id))) throw new ForbiddenError('setDelegates');
    if (unique.length > 0) {
      const members = await trx
        .selectFrom('workspace_members')
        .select('user_id')
        .where('workspace_id', '=', account.workspace_id)
        .where('user_id', 'in', unique)
        .execute();
      if (members.length !== unique.length) throw new RefusedError('delegue_hors_espace', 'Un délégué doit être membre de l’espace.');
    }
    const delegates = unique.filter((id) => id !== account.holder_user_id); // le titulaire n'a pas besoin d'être son propre délégué
    await trx.deleteFrom('account_delegates').where('account_id', '=', accountId).execute();
    if (delegates.length > 0) {
      await trx.insertInto('account_delegates').values(delegates.map((id) => ({ account_id: accountId, workspace_id: account.workspace_id, user_id: id }))).execute();
    }
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', account.workspace_id).executeTakeFirstOrThrow();
    await audit(trx, ws.org_id, account.workspace_id, userId, 'compte.delegues', 'social_account', accountId, { delegates }, now);
  });
}

export async function listDelegates(db: Database, userId: string, accountId: string): Promise<string[]> {
  return asUser(db, userId, async (trx) => {
    const rows = await trx.selectFrom('account_delegates').select('user_id').where('account_id', '=', accountId).execute();
    return rows.map((row) => row.user_id);
  });
}

/**
 * LNK-07 : pause d'un compte sans le déconnecter (plus de publication) ; reprise. Sert aussi
 * à la bascule depuis l'outil actuel (RÈG-21) : un compte reste en pause tant que l'ancien
 * système publie pour lui.
 */
export async function setAccountPaused(db: Database, userId: string, accountId: string, paused: boolean, now: Date): Promise<'paused' | 'connected' | 'expired'> {
  const account = await asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('social_accounts').select(['workspace_id', 'status']).where('id', '=', accountId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Compte');
    if (!(await isManager(trx, userId, row.workspace_id))) throw new ForbiddenError('pause');
    if (row.status === 'revoked') throw new RefusedError('compte_revoque', 'Ce compte est déconnecté : reconnectez-le d’abord.');
    return row;
  });
  return asSystem(db, async (trx) => {
    let status: 'paused' | 'connected' | 'expired' = 'paused';
    if (!paused) {
      // À la reprise, l'état réel de la connexion décide (la surveillance quotidienne affinera).
      const token = await trx.selectFrom('social_tokens').select(['expires_at', 'refresh_expires_at']).where('account_id', '=', accountId).executeTakeFirst();
      const valid = token !== undefined && (token.refresh_expires_at ?? token.expires_at).getTime() > now.getTime();
      status = valid ? 'connected' : 'expired';
    }
    await trx.updateTable('social_accounts').set({ status }).where('id', '=', accountId).execute();
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', account.workspace_id).executeTakeFirstOrThrow();
    await audit(trx, ws.org_id, account.workspace_id, userId, paused ? 'compte.pause' : 'compte.reprise', 'social_account', accountId, {}, now);
    return status;
  });
}

/**
 * PUB-09 : publication manuelle (envoi par e-mail au titulaire au créneau) ou automatique,
 * choisie par un administrateur ou par le titulaire du compte.
 */
export async function setPublishMode(db: Database, userId: string, accountId: string, mode: 'auto' | 'manual', now: Date): Promise<void> {
  if (mode !== 'auto' && mode !== 'manual') throw new RefusedError('choix_inconnu', 'Choix inconnu.');
  const account = await asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('social_accounts').select(['workspace_id', 'holder_user_id']).where('id', '=', accountId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Compte');
    if (row.holder_user_id !== userId && !(await isManager(trx, userId, row.workspace_id))) throw new ForbiddenError('publishMode');
    return row;
  });
  await asSystem(db, async (trx) => {
    await trx.updateTable('social_accounts').set({ publish_mode: mode }).where('id', '=', accountId).execute();
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', account.workspace_id).executeTakeFirstOrThrow();
    await audit(trx, ws.org_id, account.workspace_id, userId, mode === 'manual' ? 'compte.publication_manuelle' : 'compte.publication_automatique', 'social_account', accountId, {}, now);
  });
}

/**
 * LNK-08 : publication par un scénario du client (Make, Zapier, n8n…). L'adresse doit être
 * publique et en HTTPS ; le secret de signature (HMAC-SHA256) est renvoyé une seule fois.
 */
export async function setAccountWebhook(db: Database, cipher: TokenEncryptor, userId: string, accountId: string, rawUrl: string, now: Date): Promise<string> {
  let url: URL;
  try {
    url = checkPublicUrl(rawUrl.trim());
  } catch {
    throw new RefusedError('webhook_invalide', 'Adresse de webhook invalide ou interdite.');
  }
  if (url.protocol !== 'https:' || url.toString().length > 500) throw new RefusedError('webhook_invalide', 'L’adresse du webhook doit commencer par https://.');
  const account = await asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('social_accounts').select(['workspace_id', 'holder_user_id']).where('id', '=', accountId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Compte');
    if (row.holder_user_id !== userId && !(await isManager(trx, userId, row.workspace_id))) throw new ForbiddenError('webhook');
    return row;
  });
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  await asSystem(db, async (trx) => {
    const values = { url: url.toString(), secret_enc: Buffer.from(cipher.encrypt(secret, `webhook:${accountId}`)), created_by: userId, created_at: now };
    await trx.insertInto('account_webhooks').values({ account_id: accountId, workspace_id: account.workspace_id, ...values }).onConflict((oc) => oc.column('account_id').doUpdateSet(values)).execute();
    await trx.updateTable('social_accounts').set({ publish_mode: 'webhook' }).where('id', '=', accountId).execute();
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', account.workspace_id).executeTakeFirstOrThrow();
    await audit(trx, ws.org_id, account.workspace_id, userId, 'compte.publication_webhook', 'social_account', accountId, { host: url.host }, now);
  });
  return secret;
}

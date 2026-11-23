/**
 * Comptes LinkedIn d'un espace : connexion d'un profil par son titulaire (LNK-01),
 * consentement (LNK-09), un compte dans un seul espace actif (LNK-06), fiche (LNK-03),
 * déconnexion (LNK-05).
 *
 * Les jetons sont des données réservées au système : l'autorisation est vérifiée sous
 * l'identité de la personne (RLS), puis l'écriture des jetons se fait en contexte système.
 */
import { AUTO_VALIDATION_REASON, type Actor, applyPostCommand } from '@posts-auto/core';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { type LinkedInOAuth } from '@posts-auto/linkedin';
import { loadAccess } from '../access.ts';
import { TRIAL_MAX_ACCOUNTS, canConnectAccount, trialStateForWorkspace } from '../billing/trial.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { accountProfileDefaults } from '../admin/platform.ts';

/** Version du texte de consentement affiché (conservée avec chaque consentement). */
export const CONSENT_TEXT_VERSION = 'consentement-v1-2026-11';

export interface TokenEncryptor {
  encrypt(plaintext: string, boundTo: string): Uint8Array;
}

export interface ConnectProfileInput {
  readonly userId: string;
  readonly workspaceId: string;
  /** Code renvoyé par LinkedIn après autorisation. */
  readonly code: string;
  /** Consentement facultatif : utilisation de ses posts pour améliorer la rédaction (EDI-06, SUI-04). */
  readonly aiLearning: boolean;
  readonly ip?: string;
}

export interface ConnectedAccount {
  readonly accountId: string;
  readonly displayName: string;
  /** Le compte existait déjà dans l'espace (reconnexion, LNK-04). */
  readonly reconnected: boolean;
}

export async function connectProfile(
  db: Database,
  deps: { readonly oauth: LinkedInOAuth; readonly cipher: TokenEncryptor },
  input: ConnectProfileInput,
  now: Date,
): Promise<ConnectedAccount> {
  // La personne doit appartenir à l'espace (vérifié sous son identité, avant tout appel à LinkedIn).
  const visible = await asUser(db, input.userId, (trx) =>
    trx.selectFrom('workspaces').select('id').where('id', '=', input.workspaceId).executeTakeFirst(),
  );
  if (visible === undefined) throw new NotFoundError('Espace');

  const tokens = await deps.oauth.exchangeCode(input.code, now);
  if (!tokens.scopes.includes('w_member_social')) {
    throw new RefusedError('publication_non_autorisee', 'La permission de publier n’a pas été accordée sur LinkedIn.');
  }
  const profile = await deps.oauth.memberProfile(tokens.accessToken);

  return asSystem(db, async (trx) => {
    const elsewhere = await trx
      .selectFrom('social_accounts')
      .select('id')
      .where('network', '=', 'linkedin')
      .where('external_urn', '=', profile.urn)
      .where('status', '<>', 'revoked')
      .where('workspace_id', '<>', input.workspaceId)
      .executeTakeFirst();
    if (elsewhere !== undefined) {
      throw new RefusedError('account_in_other_workspace', 'Ce profil LinkedIn est déjà connecté dans un autre espace (LNK-06).');
    }

    const existing = await trx
      .selectFrom('social_accounts')
      .select('id')
      .where('workspace_id', '=', input.workspaceId)
      .where('external_urn', '=', profile.urn)
      .orderBy('updated_at', 'desc')
      .executeTakeFirst();
    // ONB-06 : pendant l'essai, 3 comptes au plus ; après l'essai, aucun nouveau compte.
    // Une reconnexion (compte déjà dans l'espace) reste toujours possible.
    if (existing === undefined) {
      const allowed = canConnectAccount(await trialStateForWorkspace(trx, input.workspaceId, now));
      if (!allowed.ok) {
        throw new RefusedError(
          allowed.code,
          allowed.code === 'essai_termine'
            ? 'L’essai gratuit est terminé : un nouveau compte se connecte avec l’abonnement.'
            : `L’essai gratuit est limité à ${TRIAL_MAX_ACCOUNTS} comptes LinkedIn.`,
        );
      }
    }

    const values = {
      display_name: profile.name,
      avatar_url: profile.pictureUrl,
      holder_user_id: input.userId,
      status: 'connected' as const,
    };
    const accountId = existing
      ? (await trx.updateTable('social_accounts').set(values).where('id', '=', existing.id).returning('id').executeTakeFirstOrThrow()).id
      : (
          await trx
            .insertInto('social_accounts')
            .values({ ...values, workspace_id: input.workspaceId, kind: 'profile', external_urn: profile.urn })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

    const tokenRow = {
      workspace_id: input.workspaceId,
      oauth_client_id: deps.oauth.clientId,
      access_token_enc: Buffer.from(deps.cipher.encrypt(tokens.accessToken, accountId)),
      refresh_token_enc: tokens.refreshToken === null ? null : Buffer.from(deps.cipher.encrypt(tokens.refreshToken, accountId)),
      scopes: [...tokens.scopes],
      expires_at: tokens.expiresAt,
      refresh_expires_at: tokens.refreshExpiresAt,
      last_checked_at: now,
      connected_by: input.userId,
      // Nouvelle connexion : les alertes d'expiration repartent de zéro (LNK-04).
      expiry_alerts_sent: [] as string[],
    };
    await trx
      .insertInto('social_tokens')
      .values({ account_id: accountId, ...tokenRow })
      .onConflict((oc) => oc.column('account_id').doUpdateSet(tokenRow))
      .execute();

    // LNK-09 : publication et conservation du profil sont nécessaires ; l'apprentissage est au choix.
    const wanted = new Set(['publish', 'store_profile', ...(input.aiLearning ? ['ai_learning'] : [])]);
    const active = await trx
      .selectFrom('account_consents')
      .select(['id', 'kind'])
      .where('account_id', '=', accountId)
      .where('user_id', '=', input.userId)
      .where('revoked_at', 'is', null)
      .execute();
    for (const consent of active) {
      // VAL-11 : « publier sans me demander » survit à une reconnexion ; il se retire à part.
      if (consent.kind !== 'auto_validate' && !wanted.has(consent.kind)) await trx.updateTable('account_consents').set({ revoked_at: now }).where('id', '=', consent.id).execute();
    }
    const missing = [...wanted].filter((kind) => !active.some((consent) => consent.kind === kind));
    if (missing.length > 0) {
      await trx
        .insertInto('account_consents')
        .values(
          missing.map((kind) => ({
            workspace_id: input.workspaceId,
            account_id: accountId,
            user_id: input.userId,
            kind,
            text_version: CONSENT_TEXT_VERSION,
            granted_at: now,
            ip: input.ip ?? null,
          })),
        )
        .execute();
    }

    await trx
      .insertInto('account_profiles')
      .values({ account_id: accountId, workspace_id: input.workspaceId, ...(await accountProfileDefaults(trx)) })
      .onConflict((oc) => oc.column('account_id').doNothing())
      .execute();

    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', input.workspaceId).executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({
        org_id: ws.org_id,
        workspace_id: input.workspaceId,
        actor_user_id: input.userId,
        actor_kind: 'user',
        action: existing ? 'compte.reconnecte' : 'compte.connecte',
        entity: 'social_account',
        entity_id: accountId,
        details: JSON.stringify({ oauthClientId: deps.oauth.clientId, scopes: tokens.scopes, aiLearning: input.aiLearning }),
        ip: input.ip ?? null,
        at: now,
      })
      .execute();

    return { accountId, displayName: profile.name, reconnected: existing !== undefined };
  });
}

const DISCONNECTED_REASON = 'Compte LinkedIn déconnecté : nouvelle validation nécessaire après reconnexion (LNK-05)';

/** LNK-05 : jeton supprimé, compte révoqué, consentements retirés, posts validés repassés « à valider ». */
export async function disconnectAccount(db: Database, userId: string, accountId: string, now: Date): Promise<void> {
  const workspaceId = await asUser(db, userId, async (trx) => {
    const account = await trx.selectFrom('social_accounts').select(['workspace_id']).where('id', '=', accountId).executeTakeFirst();
    if (account === undefined) throw new NotFoundError('Compte');
    const access = await loadAccess(trx, userId, account.workspace_id, accountId);
    const allowed = access.relation === 'holder' || access.role === 'owner' || access.role === 'admin';
    if (!allowed) throw new ForbiddenError('disconnect');
    return account.workspace_id;
  });

  const system: Actor = { kind: 'system' };
  await asSystem(db, async (trx) => {
    await trx.deleteFrom('social_tokens').where('account_id', '=', accountId).execute();
    await trx.updateTable('social_accounts').set({ status: 'revoked' }).where('id', '=', accountId).execute();
    await trx.updateTable('account_consents').set({ revoked_at: now }).where('account_id', '=', accountId).where('revoked_at', 'is', null).execute();

    const validated = await trx
      .selectFrom('posts')
      .select(['id', 'status'])
      .where('account_id', '=', accountId)
      .where('status', '=', 'valide')
      .forUpdate()
      .execute();
    for (const post of validated) {
      const result = applyPostCommand({ status: post.status, hasBlockingMarkers: false }, { type: 'withdraw', reason: DISCONNECTED_REASON }, system, now);
      if (!result.ok) continue;
      await trx.updateTable('posts').set({ status: result.status }).where('id', '=', post.id).execute();
      await trx
        .insertInto('post_status_history')
        .values({ workspace_id: workspaceId, post_id: post.id, from_status: 'valide', to_status: 'a_valider', actor_kind: 'system', reason: DISCONNECTED_REASON, at: now })
        .execute();
    }

    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({ org_id: ws.org_id, workspace_id: workspaceId, actor_user_id: userId, actor_kind: 'user', action: 'compte.deconnecte', entity: 'social_account', entity_id: accountId, at: now })
      .execute();
  });
}

export const AUTO_VALIDATE_TEXT_VERSION = 'publier-sans-me-demander-v1-2026-11';
const AUTO_VALIDATE_OFF_REASON = 'Publication sans validation désactivée par le titulaire : nouvelle validation nécessaire';

/**
 * VAL-11 : « Publier sans me demander ». Seul le titulaire décide, pour son propre compte. À la
 * désactivation, les posts validés automatiquement et pas encore partis repassent « à valider ».
 */
export async function setAutoValidate(db: Database, userId: string, accountId: string, enabled: boolean, now: Date, ip?: string): Promise<void> {
  const account = await asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('social_accounts').select(['workspace_id', 'holder_user_id']).where('id', '=', accountId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Compte');
    if (row.holder_user_id !== userId) throw new ForbiddenError('autoValidate');
    return row;
  });

  const system: Actor = { kind: 'system' };
  await asSystem(db, async (trx) => {
    const active = await trx
      .selectFrom('account_consents')
      .select('id')
      .where('account_id', '=', accountId)
      .where('user_id', '=', userId)
      .where('kind', '=', 'auto_validate')
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (enabled === (active !== undefined)) return;

    if (enabled) {
      await trx
        .insertInto('account_consents')
        .values({ workspace_id: account.workspace_id, account_id: accountId, user_id: userId, kind: 'auto_validate', text_version: AUTO_VALIDATE_TEXT_VERSION, granted_at: now, ip: ip ?? null })
        .execute();
    } else {
      await trx.updateTable('account_consents').set({ revoked_at: now }).where('id', '=', (active as { id: string }).id).execute();
      const automatic = await trx
        .selectFrom('posts as p')
        .select('p.id')
        .where('p.account_id', '=', accountId)
        .where('p.status', '=', 'valide')
        .where('p.decided_by', 'is', null)
        .where(({ exists, selectFrom }) => exists(selectFrom('post_status_history as h').select('h.id').whereRef('h.post_id', '=', 'p.id').where('h.reason', '=', AUTO_VALIDATION_REASON)))
        .forUpdate('p')
        .execute();
      for (const post of automatic) {
        const result = applyPostCommand({ status: 'valide', hasBlockingMarkers: false }, { type: 'withdraw', reason: AUTO_VALIDATE_OFF_REASON }, system, now);
        if (!result.ok) continue;
        await trx.updateTable('posts').set({ status: result.status }).where('id', '=', post.id).execute();
        await trx
          .insertInto('post_status_history')
          .values({ workspace_id: account.workspace_id, post_id: post.id, from_status: 'valide', to_status: result.status, actor_kind: 'user', actor_user_id: userId, reason: AUTO_VALIDATE_OFF_REASON, at: now })
          .execute();
      }
    }

    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', account.workspace_id).executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({
        org_id: ws.org_id,
        workspace_id: account.workspace_id,
        actor_user_id: userId,
        actor_kind: 'user',
        action: enabled ? 'compte.validation_auto_activee' : 'compte.validation_auto_desactivee',
        entity: 'social_account',
        entity_id: accountId,
        ip: ip ?? null,
        at: now,
      })
      .execute();
  });
}

/** La personne a-t-elle un profil LinkedIn connecté (ou qui expire bientôt) ? */
export async function hasConnectedProfile(db: Database, userId: string): Promise<boolean> {
  const row = await asUser(db, userId, (trx) =>
    trx
      .selectFrom('social_accounts')
      .select('id')
      .where('holder_user_id', '=', userId)
      .where('kind', '=', 'profile')
      .where('status', 'in', ['connected', 'expiring'])
      .executeTakeFirst(),
  );
  return row !== undefined;
}

export interface AccountSummary {
  readonly id: string;
  readonly kind: 'profile' | 'page';
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly status: string;
  readonly holderName: string | null;
  readonly holderUserId: string | null;
  readonly isMine: boolean;
  /** LNK-03 : échéance de la connexion (jeton de renouvellement s'il existe, sinon jeton d'accès). */
  readonly connectionExpiresAt: Date | null;
  readonly canDisconnect: boolean;
  /** PUB-09 : « manual » : envoi par e-mail au titulaire ; LNK-08 : « webhook » : scénario du client. */
  readonly publishMode: 'auto' | 'manual' | 'webhook';
  /** LNK-08 : adresse du webhook (hôte seulement), quand le compte publie par un scénario. */
  readonly webhookHost: string | null;
  /** VAL-11 : le titulaire a activé « publier sans me demander ». */
  readonly autoValidate: boolean;
}

/** LNK-03 : comptes d'un espace avec l'état de leur connexion. */
export async function listWorkspaceAccounts(db: Database, userId: string, workspaceId: string): Promise<AccountSummary[]> {
  const accounts = await asUser(db, userId, async (trx) => {
    const rows = await trx
      .selectFrom('social_accounts as a')
      .leftJoin('users as u', 'u.id', 'a.holder_user_id')
      .select(['a.id', 'a.kind', 'a.display_name', 'a.avatar_url', 'a.status', 'a.holder_user_id', 'a.publish_mode', 'u.full_name'])
      .where('a.workspace_id', '=', workspaceId)
      .where('a.status', '<>', 'revoked')
      .orderBy('a.kind', 'desc')
      .orderBy('a.display_name')
      .execute();
    const membership = await trx
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const owner = await trx
      .selectFrom('org_members as o')
      .innerJoin('workspaces as w', 'w.org_id', 'o.org_id')
      .select('o.role')
      .where('w.id', '=', workspaceId)
      .where('o.user_id', '=', userId)
      .where('o.role', '=', 'owner')
      .executeTakeFirst();
    return { rows, manager: owner !== undefined || membership?.role === 'admin' };
  });
  if (accounts.rows.length === 0) return [];

  const webhooks = await asSystem(db, (trx) =>
    trx
      .selectFrom('account_webhooks')
      .select(['account_id', 'url'])
      .where('account_id', 'in', accounts.rows.map((row) => row.id))
      .execute(),
  );
  // Échéances des jetons : table réservée au système, lue seulement pour les comptes visibles.
  const tokens = await asSystem(db, (trx) =>
    trx
      .selectFrom('social_tokens')
      .select(['account_id', 'expires_at', 'refresh_expires_at'])
      .where('account_id', 'in', accounts.rows.map((row) => row.id))
      .execute(),
  );
  const autoValidated = await asSystem(db, (trx) =>
    trx
      .selectFrom('account_consents')
      .select(['account_id', 'user_id'])
      .where('account_id', 'in', accounts.rows.map((row) => row.id))
      .where('kind', '=', 'auto_validate')
      .where('revoked_at', 'is', null)
      .execute(),
  );
  return accounts.rows.map((row) => {
    const token = tokens.find((t) => t.account_id === row.id);
    const isMine = row.holder_user_id === userId;
    return {
      id: row.id,
      kind: row.kind as 'profile' | 'page',
      name: row.display_name ?? 'Compte LinkedIn',
      avatarUrl: row.avatar_url,
      status: row.status,
      holderName: row.full_name,
      holderUserId: row.holder_user_id,
      isMine,
      connectionExpiresAt: token ? (token.refresh_expires_at ?? token.expires_at) : null,
      canDisconnect: isMine || accounts.manager,
      publishMode: row.publish_mode === 'manual' ? 'manual' : row.publish_mode === 'webhook' ? 'webhook' : 'auto',
      webhookHost: (() => {
        const hook = webhooks.find((w) => w.account_id === row.id);
        return hook === undefined ? null : new URL(hook.url).host;
      })(),
      autoValidate: autoValidated.some((consent) => consent.account_id === row.id && consent.user_id === row.holder_user_id),
    };
  });
}

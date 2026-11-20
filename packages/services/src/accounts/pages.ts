/**
 * Connexion des pages d'entreprise (LNK-02) : une personne qui administre les pages sur
 * LinkedIn se connecte une fois ; l'application liste les pages qu'elle administre, elle
 * coche celles à ajouter à l'espace.
 *
 * Entre l'autorisation et le choix, le jeton attend dans page_connections, chiffré et lié à
 * cette attente, 15 minutes au plus. Chaque page ajoutée reçoit sa propre copie chiffrée du
 * jeton (liée au compte), comme un profil. Mêmes règles qu'un profil : une page n'appartient
 * qu'à un espace actif (LNK-06), et l'essai gratuit limite le nombre de comptes (ONB-06).
 *
 * Réservé à la gestion du contenu de l'espace (matrice 3.3).
 */
import { addMinutes } from '@posts-auto/core';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { type LinkedInOAuth, type LinkedInPages, PAGE_PUBLISH_SCOPE } from '@posts-auto/linkedin';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit } from '../audit.ts';
import { TRIAL_MAX_ACCOUNTS, canConnectAccount, trialStateForWorkspace } from '../billing/trial.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { CONSENT_TEXT_VERSION, type TokenEncryptor } from './accounts.ts';
import { accountProfileDefaults } from '../admin/platform.ts';

export const PAGE_CHOICE_MINUTES = 15;

export interface TokenCrypto extends TokenEncryptor {
  decrypt(payload: Uint8Array, boundTo: string): string;
}

export interface PageChoice {
  readonly urn: string;
  readonly name: string;
  readonly vanityName: string | null;
  /** Déjà dans cet espace : une nouvelle connexion renouvelle son jeton. */
  readonly inWorkspace: boolean;
  /** Déjà connectée dans un autre espace (LNK-06) : impossible de l'ajouter ici. */
  readonly elsewhere: boolean;
}

async function requireManager(db: Database, userId: string, workspaceId: string): Promise<void> {
  await asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    if (!canManageContent(role)) throw new ForbiddenError('connectPages');
  });
}

/** Retour de LinkedIn : jeton obtenu, pages administrées listées ; renvoie l'attente à confirmer. */
export async function startPageConnection(
  db: Database,
  deps: { readonly oauth: LinkedInOAuth; readonly pages: LinkedInPages; readonly cipher: TokenCrypto },
  input: { readonly userId: string; readonly workspaceId: string; readonly code: string },
  now: Date,
): Promise<string> {
  await requireManager(db, input.userId, input.workspaceId);
  const tokens = await deps.oauth.exchangeCode(input.code, now);
  if (!tokens.scopes.includes(PAGE_PUBLISH_SCOPE)) {
    throw new RefusedError('publication_pages_non_autorisee', 'La permission de publier au nom des pages n’a pas été accordée sur LinkedIn.');
  }
  const pages = await deps.pages.administeredPages(tokens.accessToken);
  if (pages.length === 0) throw new RefusedError('aucune_page', 'Ce compte LinkedIn n’administre aucune page d’entreprise.');
  return asSystem(db, async (trx) => {
    // Attentes expirées : effacées au passage.
    await trx.deleteFrom('page_connections').where('expires_at', '<', now).execute();
    const row = await trx
      .insertInto('page_connections')
      .values({
        workspace_id: input.workspaceId,
        user_id: input.userId,
        oauth_client_id: deps.oauth.clientId,
        // Chiffré lié à une valeur provisoire, puis à l'identifiant de l'attente.
        access_token_enc: Buffer.alloc(0),
        scopes: [...tokens.scopes],
        token_expires_at: tokens.expiresAt,
        refresh_expires_at: tokens.refreshExpiresAt,
        pages: JSON.stringify(pages),
        expires_at: addMinutes(now, PAGE_CHOICE_MINUTES),
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('page_connections')
      .set({
        access_token_enc: Buffer.from(deps.cipher.encrypt(tokens.accessToken, row.id)),
        refresh_token_enc: tokens.refreshToken === null ? null : Buffer.from(deps.cipher.encrypt(tokens.refreshToken, row.id)),
      })
      .where('id', '=', row.id)
      .execute();
    return row.id;
  });
}

/** Pages proposées, pour l'écran de choix ; null si l'attente a expiré ou n'est pas à cette personne. */
export async function pendingPageConnection(db: Database, userId: string, workspaceId: string, pendingId: string, now: Date): Promise<PageChoice[] | null> {
  await requireManager(db, userId, workspaceId);
  return asSystem(db, async (trx) => {
    const pending = await trx
      .selectFrom('page_connections')
      .select('pages')
      .where('id', '=', pendingId)
      .where('user_id', '=', userId)
      .where('workspace_id', '=', workspaceId)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    if (pending === undefined) return null;
    const pages = pending.pages as { urn: string; name: string; vanityName: string | null }[];
    const known = await trx
      .selectFrom('social_accounts')
      .select(['external_urn', 'workspace_id'])
      .where('external_urn', 'in', pages.length > 0 ? pages.map((p) => p.urn) : ['-'])
      .where('status', '<>', 'revoked')
      .execute();
    return pages.map((p) => ({
      ...p,
      inWorkspace: known.some((k) => k.external_urn === p.urn && k.workspace_id === workspaceId),
      elsewhere: known.some((k) => k.external_urn === p.urn && k.workspace_id !== workspaceId),
    }));
  });
}

/** Ajoute (ou reconnecte) les pages cochées ; renvoie le nombre de pages enregistrées. */
export async function confirmPageConnection(
  db: Database,
  cipher: TokenCrypto,
  input: { readonly userId: string; readonly workspaceId: string; readonly pendingId: string; readonly urns: readonly string[] },
  now: Date,
): Promise<number> {
  await requireManager(db, input.userId, input.workspaceId);
  if (input.urns.length === 0) throw new RefusedError('aucune_page_choisie', 'Cochez au moins une page.');
  return asSystem(db, async (trx) => {
    const pending = await trx
      .selectFrom('page_connections')
      .selectAll()
      .where('id', '=', input.pendingId)
      .where('user_id', '=', input.userId)
      .where('workspace_id', '=', input.workspaceId)
      .where('expires_at', '>', now)
      .forUpdate()
      .executeTakeFirst();
    if (pending === undefined) throw new RefusedError('connexion-expiree', 'Le choix des pages a expiré : reconnectez-vous à LinkedIn.');
    const offered = pending.pages as { urn: string; name: string; vanityName: string | null }[];
    const chosen = offered.filter((p) => input.urns.includes(p.urn));
    if (chosen.length === 0) throw new RefusedError('aucune_page_choisie', 'Cochez au moins une page.');
    const accessToken = cipher.decrypt(pending.access_token_enc, pending.id);
    const refreshToken = pending.refresh_token_enc === null ? null : cipher.decrypt(pending.refresh_token_enc, pending.id);

    for (const page of chosen) {
      const elsewhere = await trx
        .selectFrom('social_accounts')
        .select('id')
        .where('external_urn', '=', page.urn)
        .where('status', '<>', 'revoked')
        .where('workspace_id', '<>', input.workspaceId)
        .executeTakeFirst();
      if (elsewhere !== undefined) throw new RefusedError('account_in_other_workspace', `La page « ${page.name} » est déjà connectée dans un autre espace (LNK-06).`);
      const existing = await trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', input.workspaceId).where('external_urn', '=', page.urn).executeTakeFirst();
      if (existing === undefined) {
        const allowed = canConnectAccount(await trialStateForWorkspace(trx, input.workspaceId, now));
        if (!allowed.ok) {
          throw new RefusedError(allowed.code, allowed.code === 'essai_termine' ? 'L’essai gratuit est terminé.' : `L’essai gratuit est limité à ${TRIAL_MAX_ACCOUNTS} comptes LinkedIn.`);
        }
      }
      const values = { display_name: page.name, profile_url: page.vanityName ? `https://www.linkedin.com/company/${page.vanityName}/` : null, status: 'connected' as const };
      const accountId = existing
        ? (await trx.updateTable('social_accounts').set(values).where('id', '=', existing.id).returning('id').executeTakeFirstOrThrow()).id
        : (await trx.insertInto('social_accounts').values({ ...values, workspace_id: input.workspaceId, kind: 'page', external_urn: page.urn }).returning('id').executeTakeFirstOrThrow()).id;
      const tokenRow = {
        workspace_id: input.workspaceId,
        oauth_client_id: pending.oauth_client_id,
        access_token_enc: Buffer.from(cipher.encrypt(accessToken, accountId)),
        refresh_token_enc: refreshToken === null ? null : Buffer.from(cipher.encrypt(refreshToken, accountId)),
        scopes: pending.scopes,
        expires_at: pending.token_expires_at,
        refresh_expires_at: pending.refresh_expires_at,
        last_checked_at: now,
        connected_by: input.userId,
        expiry_alerts_sent: [] as string[],
      };
      await trx.insertInto('social_tokens').values({ account_id: accountId, ...tokenRow }).onConflict((oc) => oc.column('account_id').doUpdateSet(tokenRow)).execute();
      const published = await trx
        .selectFrom('account_consents')
        .select('id')
        .where('account_id', '=', accountId)
        .where('user_id', '=', input.userId)
        .where('kind', '=', 'publish')
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (published === undefined) {
        await trx
          .insertInto('account_consents')
          .values({ workspace_id: input.workspaceId, account_id: accountId, user_id: input.userId, kind: 'publish', text_version: CONSENT_TEXT_VERSION, granted_at: now })
          .execute();
      }
      await trx.insertInto('account_profiles').values({ account_id: accountId, workspace_id: input.workspaceId, ...(await accountProfileDefaults(trx)) }).onConflict((oc) => oc.column('account_id').doNothing()).execute();
      await audit(trx, { workspaceId: input.workspaceId, actorUserId: input.userId, action: existing ? 'page.reconnectee' : 'page.connectee', entity: 'social_account', entityId: accountId, details: { urn: page.urn }, at: now });
    }
    await trx.deleteFrom('page_connections').where('id', '=', pending.id).execute();
    return chosen.length;
  });
}

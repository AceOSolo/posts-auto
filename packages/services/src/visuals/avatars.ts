/**
 * VIS-06 : personnage de marque autorisé. Seul le titulaire déclare l'avatar généré de
 * lui-même, en acceptant un texte de consentement versionné, enregistré avec la date et
 * l'adresse IP. L'avatar n'entre pas dans la médiathèque de l'espace : il ne peut illustrer
 * que les posts de ce compte. Le titulaire ou un administrateur le retire à tout moment ;
 * les visuels déjà publiés ne changent pas.
 */
import { randomUUID } from 'node:crypto';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { loadAccess } from '../access.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { checkImage } from '../media/image-check.ts';

export const AVATAR_CONSENT_VERSION = '2026-11-20';
export const AVATAR_CONSENT_TEXT =
  "J'autorise l'utilisation de cet avatar, image générée qui me représente, dans les visuels des posts publiés sur mon propre compte LinkedIn, et seulement sur celui-ci. Chaque visuel qui l'utilise porte la mention « image générée par IA ». Je peux retirer cette autorisation à tout moment.";

export interface AvatarState {
  readonly assetId: string;
  readonly consentedAt: Date;
  readonly consentVersion: string;
}

async function accountOf(db: Database, userId: string, accountId: string) {
  return asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('social_accounts').select(['workspace_id', 'holder_user_id', 'kind']).where('id', '=', accountId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Compte');
    const access = await loadAccess(trx, userId, row.workspace_id, accountId);
    return { ...row, access };
  });
}

export async function accountAvatar(db: Database, userId: string, accountId: string): Promise<AvatarState | null> {
  await accountOf(db, userId, accountId);
  const row = await asSystem(db, (trx) => trx.selectFrom('account_avatars').select(['asset_id', 'consented_at', 'consent_version']).where('account_id', '=', accountId).where('revoked_at', 'is', null).executeTakeFirst());
  return row === undefined ? null : { assetId: row.asset_id, consentedAt: row.consented_at, consentVersion: row.consent_version };
}

/** Déclaration par le titulaire lui-même (profil personnel), consentement coché. */
export async function declareAvatar(
  db: Database,
  media: MediaWriter,
  userId: string,
  accountId: string,
  input: { readonly bytes: Uint8Array; readonly mime?: string; readonly consent: boolean; readonly ip?: string },
  now: Date,
): Promise<string> {
  const account = await accountOf(db, userId, accountId);
  if (account.kind !== 'profile' || account.holder_user_id !== userId) throw new ForbiddenError('declareAvatar');
  if (!input.consent) throw new RefusedError('consentement_requis', 'Cochez la case d’accord pour déclarer votre avatar.');
  const checked = checkImage(input.bytes, input.mime);
  if (!checked.ok) throw new RefusedError(checked.code, 'Image refusée.');
  const assetId = randomUUID();
  const extension = checked.mime === 'image/png' ? 'png' : checked.mime === 'image/gif' ? 'gif' : 'jpg';
  const storageKey = `${account.workspace_id}/avatars/${accountId}/${assetId}.${extension}`;
  await media.write(storageKey, checked.bytes);
  await asSystem(db, async (trx) => {
    await trx
      .insertInto('media_assets')
      .values({ id: assetId, workspace_id: account.workspace_id, kind: 'upload', storage_key: storageKey, mime: checked.mime, bytes: checked.bytes.length, ai_generated: true, label: 'Avatar du titulaire', uploaded_by: userId, created_at: now })
      .execute();
    const values = { asset_id: assetId, consent_version: AVATAR_CONSENT_VERSION, consent_text: AVATAR_CONSENT_TEXT, consented_by: userId, consented_at: now, consent_ip: input.ip ?? null, revoked_at: null };
    await trx.insertInto('account_avatars').values({ account_id: accountId, workspace_id: account.workspace_id, ...values }).onConflict((oc) => oc.column('account_id').doUpdateSet(values)).execute();
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', account.workspace_id).executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({ org_id: ws.org_id, workspace_id: account.workspace_id, actor_user_id: userId, actor_kind: 'user', action: 'avatar.declare', entity: 'social_account', entity_id: accountId, details: JSON.stringify({ consentVersion: AVATAR_CONSENT_VERSION }), at: now })
      .execute();
  });
  return assetId;
}

/** Retrait par le titulaire ou un administrateur : plus aucun nouveau visuel ne l'utilise. */
export async function revokeAvatar(db: Database, userId: string, accountId: string, now: Date): Promise<void> {
  const account = await accountOf(db, userId, accountId);
  const manager = account.access.actor.kind === 'user' && account.access.actor.isWorkspaceManager;
  if (account.holder_user_id !== userId && !manager) throw new ForbiddenError('revokeAvatar');
  await asSystem(db, async (trx) => {
    const updated = await trx.updateTable('account_avatars').set({ revoked_at: now }).where('account_id', '=', accountId).where('revoked_at', 'is', null).returning('account_id').executeTakeFirst();
    if (updated === undefined) return;
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', account.workspace_id).executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({ org_id: ws.org_id, workspace_id: account.workspace_id, actor_user_id: userId, actor_kind: 'user', action: 'avatar.retire', entity: 'social_account', entity_id: accountId, details: JSON.stringify({}), at: now })
      .execute();
  });
}

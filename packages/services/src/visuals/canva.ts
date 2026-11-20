/**
 * VIS-07 : connexion d'un espace au Canva du client et modèles de marque Canva. Les jetons
 * sont chiffrés (SEC-02) et renouvelés avant leur échéance ; seul qui gère le contenu
 * connecte Canva et choisit les modèles.
 */
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import { type CanvaApi, type CanvaFieldMap, galleryTemplates, guessCanvaFieldMap } from '@posts-auto/visuals';
import { canManageContent, workspaceRole } from '../access.ts';
import type { TokenCrypto } from '../accounts/pages.ts';
import { audit } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { loadBranding } from './branding.ts';

async function requireManager(db: Database, userId: string, workspaceId: string): Promise<void> {
  const role = await asUser(db, userId, (trx) => workspaceRole(trx, userId, workspaceId));
  if (role === null) throw new NotFoundError('Espace');
  if (!canManageContent(role)) throw new ForbiddenError('canva');
}

export async function confirmCanvaConnection(
  db: Database,
  api: CanvaApi,
  cipher: TokenCrypto,
  userId: string,
  workspaceId: string,
  input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
  now: Date,
): Promise<void> {
  await requireManager(db, userId, workspaceId);
  const tokens = await api.exchangeCode(input, now);
  await asSystem(db, async (trx) => {
    const values = {
      access_token_enc: Buffer.from(cipher.encrypt(tokens.accessToken, `canva:${workspaceId}`)),
      refresh_token_enc: Buffer.from(cipher.encrypt(tokens.refreshToken, `canva-refresh:${workspaceId}`)),
      expires_at: tokens.expiresAt,
      connected_by: userId,
      connected_at: now,
    };
    await trx.insertInto('canva_connections').values({ workspace_id: workspaceId, ...values }).onConflict((oc) => oc.column('workspace_id').doUpdateSet(values)).execute();
  });
  await asUser(db, userId, (trx) => audit(trx, { workspaceId, actorUserId: userId, action: 'canva.connecte', entity: 'workspace', entityId: workspaceId, details: {}, at: now }));
}

export async function canvaStatus(db: Database, userId: string, workspaceId: string): Promise<{ readonly connected: boolean; readonly connectedAt: Date | null }> {
  await requireManager(db, userId, workspaceId);
  const row = await asSystem(db, (trx) => trx.selectFrom('canva_connections').select('connected_at').where('workspace_id', '=', workspaceId).executeTakeFirst());
  return { connected: row !== undefined, connectedAt: row?.connected_at ?? null };
}

export async function disconnectCanva(db: Database, userId: string, workspaceId: string, now: Date): Promise<void> {
  await requireManager(db, userId, workspaceId);
  await asSystem(db, (trx) => trx.deleteFrom('canva_connections').where('workspace_id', '=', workspaceId).execute());
  await asUser(db, userId, (trx) => audit(trx, { workspaceId, actorUserId: userId, action: 'canva.deconnecte', entity: 'workspace', entityId: workspaceId, details: {}, at: now }));
}

/** Jeton d'accès valable (renouvelé à 5 minutes de l'échéance) ; null sans connexion. */
export async function canvaAccessToken(trx: Tx, api: CanvaApi, cipher: TokenCrypto, workspaceId: string, now: Date): Promise<string | null> {
  const row = await trx.selectFrom('canva_connections').selectAll().where('workspace_id', '=', workspaceId).forUpdate().executeTakeFirst();
  if (row === undefined) return null;
  if (row.expires_at.getTime() - now.getTime() > 5 * 60_000) return cipher.decrypt(row.access_token_enc, `canva:${workspaceId}`);
  const tokens = await api.refresh(cipher.decrypt(row.refresh_token_enc, `canva-refresh:${workspaceId}`), now);
  await trx
    .updateTable('canva_connections')
    .set({
      access_token_enc: Buffer.from(cipher.encrypt(tokens.accessToken, `canva:${workspaceId}`)),
      refresh_token_enc: Buffer.from(cipher.encrypt(tokens.refreshToken, `canva-refresh:${workspaceId}`)),
      expires_at: tokens.expiresAt,
    })
    .where('workspace_id', '=', workspaceId)
    .execute();
  return tokens.accessToken;
}

export interface CanvaTemplateChoice {
  readonly id: string;
  readonly title: string;
  readonly added: boolean;
}

/** Modèles de marque du Canva du client, et ceux déjà ajoutés à l'espace. */
export async function listCanvaBrandTemplates(db: Database, api: CanvaApi, cipher: TokenCrypto, userId: string, workspaceId: string, now: Date): Promise<CanvaTemplateChoice[]> {
  await requireManager(db, userId, workspaceId);
  const token = await asSystem(db, (trx) => canvaAccessToken(trx, api, cipher, workspaceId, now));
  if (token === null) throw new RefusedError('canva_non_connecte', 'Connectez d’abord Canva.');
  const added = new Set(
    (await asSystem(db, (trx) => trx.selectFrom('templates').select('canva_brand_template_id').where('workspace_id', '=', workspaceId).where('canva_brand_template_id', 'is not', null).where('archived_at', 'is', null).execute())).map(
      (r) => r.canva_brand_template_id,
    ),
  );
  return (await api.brandTemplates(token)).map((t) => ({ ...t, added: added.has(t.id) }));
}

/**
 * Ajoute un modèle de marque Canva aux modèles de l'espace : ses champs sont reliés aux zones
 * du visuel d'après leur nom ; il faut au moins un champ de titre.
 */
export async function addCanvaTemplate(db: Database, api: CanvaApi, cipher: TokenCrypto, userId: string, workspaceId: string, brandTemplateId: string, now: Date): Promise<string> {
  await requireManager(db, userId, workspaceId);
  const token = await asSystem(db, (trx) => canvaAccessToken(trx, api, cipher, workspaceId, now));
  if (token === null) throw new RefusedError('canva_non_connecte', 'Connectez d’abord Canva.');
  const template = (await api.brandTemplates(token)).find((t) => t.id === brandTemplateId);
  if (template === undefined) throw new RefusedError('modele_canva_inconnu', 'Modèle Canva introuvable.');
  const fields: CanvaFieldMap = guessCanvaFieldMap(await api.dataset(token, brandTemplateId));
  if (fields.title === undefined) throw new RefusedError('modele_canva_sans_titre', 'Ce modèle Canva n’a pas de champ de texte à remplir.');
  return asUser(db, userId, async (trx) => {
    const brand = await loadBranding(trx, workspaceId);
    // Définition locale : choix du modèle (photo ou non) et rendu de secours.
    const fallback = galleryTemplates(brand).find((t) => t.withPhoto === (fields.photo !== undefined)) ?? (galleryTemplates(brand)[0] as NonNullable<ReturnType<typeof galleryTemplates>[number]>);
    const row = await trx
      .insertInto('templates')
      .values({
        workspace_id: workspaceId,
        name: template.title.slice(0, 80),
        format: fallback.definition.format,
        definition: JSON.stringify(fallback.definition),
        canva_brand_template_id: brandTemplateId,
        canva_fields: JSON.stringify(fields),
        created_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'canva.modele_ajoute', entity: 'template', entityId: row.id, details: { brandTemplateId, fields }, at: now });
    return row.id;
  });
}

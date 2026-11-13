/**
 * Sources de veille de l'espace (GEN-09) : flux RSS ou Atom dont la rédaction peut tirer des
 * posts, en citant le lien. Gérées par l'équipe de rédaction ; visibles par tous les membres.
 * La relève elle-même est faite par la tâche « veille », avec la protection du réseau interne.
 */
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

export interface ContentSource {
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly lastFetchedAt: Date | null;
  readonly lastError: string | null;
  readonly articles: number;
  readonly unused: number;
}

async function requireRole(trx: Tx, userId: string, workspaceId: string) {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

export async function listSources(db: Database, userId: string, workspaceId: string): Promise<{ sources: ContentSource[]; canEdit: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    const rows = await trx
      .selectFrom('content_sources as s')
      .select((eb) => [
        's.id',
        's.url',
        's.label',
        's.enabled',
        's.last_fetched_at',
        's.last_error',
        eb.selectFrom('source_items as i').select((sub) => sub.fn.countAll<string>().as('n')).whereRef('i.source_id', '=', 's.id').as('articles'),
        eb.selectFrom('source_items as i').select((sub) => sub.fn.countAll<string>().as('n')).whereRef('i.source_id', '=', 's.id').where('i.used_post_id', 'is', null).as('unused'),
      ])
      .where('s.workspace_id', '=', workspaceId)
      .orderBy('s.created_at')
      .execute();
    return {
      canEdit: canManageContent(role),
      sources: rows.map((r) => ({
        id: r.id,
        url: r.url,
        label: r.label,
        enabled: r.enabled,
        lastFetchedAt: r.last_fetched_at,
        lastError: r.last_error,
        articles: Number(r.articles ?? 0),
        unused: Number(r.unused ?? 0),
      })),
    };
  });
}

/** Adresse acceptée : http ou https, sans identifiants, 1 000 caractères au plus. Le contrôle réseau complet est fait à la relève. */
export function checkSourceUrl(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RefusedError('adresse_invalide', 'Adresse invalide.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || value.length > 1000) {
    throw new RefusedError('adresse_invalide', 'Adresse invalide : http ou https, sans identifiants.');
  }
  return url.toString();
}

export async function addSource(db: Database, userId: string, workspaceId: string, input: { url: string; label: string }, now: Date): Promise<string> {
  const url = checkSourceUrl(input.url);
  const label = cleanText(input.label, 200) ?? new URL(url).hostname;
  return asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editSources');
    const existing = await trx.selectFrom('content_sources').select('id').where('workspace_id', '=', workspaceId).where('url', '=', url).executeTakeFirst();
    if (existing !== undefined) throw new RefusedError('source_existante', 'Cette source est déjà suivie.');
    const row = await trx.insertInto('content_sources').values({ workspace_id: workspaceId, url, label, created_by: userId }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'source.ajoutee', entity: 'content_source', entityId: row.id, details: { url }, at: now });
    return row.id;
  });
}

export async function setSourceEnabled(db: Database, userId: string, workspaceId: string, sourceId: string, enabled: boolean, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editSources');
    const row = await trx.updateTable('content_sources').set({ enabled }).where('id', '=', sourceId).where('workspace_id', '=', workspaceId).returning('id').executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Source');
    await audit(trx, { workspaceId, actorUserId: userId, action: enabled ? 'source.reprise' : 'source.suspendue', entity: 'content_source', entityId: sourceId, details: {}, at: now });
  });
}

export async function deleteSource(db: Database, userId: string, workspaceId: string, sourceId: string, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editSources');
    const row = await trx.deleteFrom('content_sources').where('id', '=', sourceId).where('workspace_id', '=', workspaceId).returning('url').executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Source');
    await audit(trx, { workspaceId, actorUserId: userId, action: 'source.supprimee', entity: 'content_source', entityId: sourceId, details: { url: row.url }, at: now });
  });
}

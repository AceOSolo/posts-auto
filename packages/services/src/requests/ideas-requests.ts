/**
 * Idées et demandes de post (section 5.6).
 *
 * - Idée (IDE-01) : un sujet à placer quand c'est pertinent. Proposée par tout membre sauf
 *   les lecteurs ; retenue ou écartée par la gestion du contenu ; marquée « utilisée » par
 *   la rédaction, qui écrit son suivi.
 * - Demande (IDE-03, IDE-06) : un post précis, sur des comptes et à une date, traité dans
 *   l'heure par la tâche de fond ; le demandeur suit son avancement.
 */
import { randomUUID } from 'node:crypto';
import type { PostStatus } from '@posts-auto/core';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { canManageContent, canPropose, workspaceRole } from '../access.ts';
import { audit, cleanLines, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { type ImageMime, checkImage } from '../media/image-check.ts';
import { MAX_PHOTOS_PER_POST, type UploadedPhoto } from '../posts/post-media.ts';
import { isMonday } from '../planning/planning.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXTENSIONS: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

function date(value: string | null | undefined, code: string): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const v = value.trim();
  const d = new Date(`${v}T00:00:00Z`);
  if (!ISO_DATE.test(v) || Number.isNaN(d.getTime()) || !d.toISOString().startsWith(v)) throw new RefusedError(code, 'Date invalide.');
  return v;
}

async function requireRole(trx: Tx, userId: string, workspaceId: string) {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

async function requireAccounts(trx: Tx, workspaceId: string, accountIds: readonly string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const found = await trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', workspaceId).where('status', '<>', 'revoked').where('id', 'in', [...accountIds]).execute();
  if (found.length !== new Set(accountIds).size) throw new RefusedError('compte_inconnu', 'Compte inconnu dans cet espace.');
}

// --- Idées (IDE-01, IDE-02) ---

export type IdeaStatus = 'new' | 'kept' | 'used' | 'dismissed';

export interface Idea {
  readonly id: string;
  readonly title: string;
  readonly details: string | null;
  readonly link: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly eventOn: string | null;
  readonly targetWeek: string | null;
  readonly allAccounts: boolean;
  readonly accountIds: readonly string[];
  readonly origin: 'team' | 'ai_reserve';
  readonly status: IdeaStatus;
  readonly followup: string | null;
  readonly authorName: string | null;
  readonly createdAt: Date;
  readonly posts: readonly { readonly id: string; readonly status: PostStatus }[];
  /** La personne peut la modifier (auteur ou gestion du contenu). */
  readonly canEdit: boolean;
}

export interface IdeaInput {
  readonly title: string;
  readonly details?: string | null;
  readonly link?: string | null;
  readonly startsOn?: string | null;
  readonly endsOn?: string | null;
  readonly eventOn?: string | null;
  readonly targetWeek?: string | null;
  /** Vide : tous les comptes. */
  readonly accountIds: readonly string[];
}

export async function listIdeas(
  db: Database,
  userId: string,
  workspaceId: string,
  statuses: readonly IdeaStatus[] = ['new', 'kept'],
): Promise<{ ideas: Idea[]; canPropose: boolean; canManage: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    const manager = canManageContent(role);
    const rows = await trx
      .selectFrom('ideas as i')
      .leftJoin('users as u', 'u.id', 'i.created_by')
      .select(['i.id', 'i.title', 'i.details', 'i.link', 'i.starts_on', 'i.ends_on', 'i.event_on', 'i.target_week', 'i.all_accounts', 'i.origin', 'i.status', 'i.followup', 'i.created_by', 'i.created_at', 'u.full_name', 'u.email'])
      .where('i.workspace_id', '=', workspaceId)
      .where('i.status', 'in', [...statuses])
      .orderBy('i.created_at', 'desc')
      .execute();
    const ids = rows.map((r) => r.id);
    const links = ids.length === 0 ? [] : await trx.selectFrom('idea_accounts').select(['idea_id', 'account_id']).where('idea_id', 'in', ids).execute();
    const posts = ids.length === 0 ? [] : await trx.selectFrom('posts').select(['id', 'idea_id', 'status']).where('idea_id', 'in', ids).execute();
    return {
      canPropose: canPropose(role),
      canManage: manager,
      ideas: rows.map((r) => ({
        id: r.id,
        title: r.title,
        details: r.details,
        link: r.link,
        startsOn: r.starts_on,
        endsOn: r.ends_on,
        eventOn: r.event_on,
        targetWeek: r.target_week,
        allAccounts: r.all_accounts,
        accountIds: links.filter((l) => l.idea_id === r.id).map((l) => l.account_id),
        origin: r.origin as 'team' | 'ai_reserve',
        status: r.status as IdeaStatus,
        followup: r.followup,
        authorName: r.origin === 'ai_reserve' ? null : (r.full_name ?? r.email),
        createdAt: r.created_at,
        posts: posts.filter((p) => p.idea_id === r.id).map((p) => ({ id: p.id, status: p.status })),
        canEdit: manager || (r.created_by === userId && canPropose(role)),
      })),
    };
  });
}

function ideaValues(input: IdeaInput) {
  const title = cleanText(input.title, 300);
  if (title === null) throw new RefusedError('titre_requis', 'Donnez un titre à l’idée.');
  const startsOn = date(input.startsOn, 'date_invalide');
  const endsOn = date(input.endsOn, 'date_invalide');
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) throw new RefusedError('date_fin_invalide', 'La fin doit être le même jour ou après le début.');
  const targetWeek = date(input.targetWeek, 'semaine_invalide');
  if (targetWeek !== null && !isMonday(targetWeek)) throw new RefusedError('semaine_invalide', 'Semaine invalide.');
  return {
    title,
    details: cleanText(input.details, 4000),
    link: cleanText(input.link, 1000),
    starts_on: startsOn,
    ends_on: endsOn,
    event_on: date(input.eventOn, 'date_invalide'),
    target_week: targetWeek,
    all_accounts: input.accountIds.length === 0,
  };
}

export async function saveIdea(db: Database, userId: string, workspaceId: string, ideaId: string | null, input: IdeaInput, now: Date): Promise<string> {
  const values = ideaValues(input);
  const accountIds = [...new Set(input.accountIds)];
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    if (!canPropose(role)) throw new ForbiddenError('proposeIdea');
    await requireAccounts(trx, workspaceId, accountIds);
    let id: string;
    if (ideaId === null) {
      id = (await trx.insertInto('ideas').values({ workspace_id: workspaceId, origin: 'team', created_by: userId, ...values }).returning('id').executeTakeFirstOrThrow()).id;
    } else {
      const idea = await trx.selectFrom('ideas').select(['created_by', 'status']).where('id', '=', ideaId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (idea === undefined) throw new NotFoundError('Idée');
      if (!canManageContent(role) && idea.created_by !== userId) throw new ForbiddenError('editIdea');
      if (idea.status === 'used') throw new RefusedError('idee_utilisee', 'Cette idée a déjà donné un post.');
      await trx.updateTable('ideas').set(values).where('id', '=', ideaId).execute();
      await trx.deleteFrom('idea_accounts').where('idea_id', '=', ideaId).execute();
      id = ideaId;
    }
    if (accountIds.length > 0) await trx.insertInto('idea_accounts').values(accountIds.map((accountId) => ({ idea_id: id, account_id: accountId, workspace_id: workspaceId }))).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: ideaId === null ? 'idee.proposee' : 'idee.modifiee', entity: 'idea', entityId: id, details: {}, at: now });
    return id;
  });
}

/** IDE-01 : retenir, écarter ou remettre en « nouvelle » (gestion du contenu). « Utilisée » est posé par la rédaction. */
export async function setIdeaStatus(db: Database, userId: string, workspaceId: string, ideaId: string, status: 'new' | 'kept' | 'dismissed', now: Date): Promise<void> {
  if (!['new', 'kept', 'dismissed'].includes(status)) throw new RefusedError('statut_invalide', 'Statut inconnu.');
  await asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('triageIdea');
    const idea = await trx.selectFrom('ideas').select('status').where('id', '=', ideaId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (idea === undefined) throw new NotFoundError('Idée');
    if (idea.status === 'used') throw new RefusedError('idee_utilisee', 'Cette idée a déjà donné un post.');
    await trx.updateTable('ideas').set({ status }).where('id', '=', ideaId).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: `idee.${status}`, entity: 'idea', entityId: ideaId, details: {}, at: now });
  });
}

// --- Demandes de post (IDE-03, IDE-06) ---

export type RequestStatus = 'new' | 'in_progress' | 'done' | 'impossible';

export interface PostRequest {
  readonly id: string;
  readonly rawText: string | null;
  readonly title: string | null;
  readonly details: string | null;
  readonly links: readonly string[];
  readonly wishedAt: Date | null;
  readonly accountIds: readonly string[];
  readonly photoCount: number;
  readonly status: RequestStatus;
  readonly followup: string | null;
  readonly authorName: string | null;
  readonly isMine: boolean;
  readonly createdAt: Date;
  readonly posts: readonly { readonly id: string; readonly accountId: string; readonly status: PostStatus; readonly scheduledAt: Date }[];
}

export interface PostRequestInput {
  readonly rawText?: string | null;
  readonly title?: string | null;
  readonly details?: string | null;
  readonly links?: string | readonly string[];
  readonly wishedAt?: Date | null;
  readonly accountIds: readonly string[];
  readonly photos?: readonly UploadedPhoto[];
}

/** Délai minimal d'une date souhaitée : la demande est traitée dans l'heure (IDE-06), puis validée. */
export const REQUEST_MIN_LEAD_MINUTES = 60;

export async function createPostRequest(
  db: Database,
  media: MediaWriter,
  userId: string,
  workspaceId: string,
  input: PostRequestInput,
  now: Date,
): Promise<string> {
  const rawText = cleanText(input.rawText, 5000);
  const details = cleanText(input.details, 5000);
  if (rawText === null && details === null) throw new RefusedError('demande_vide', 'Décrivez le post souhaité.');
  const accountIds = [...new Set(input.accountIds)];
  if (accountIds.length === 0) throw new RefusedError('compte_requis', 'Choisissez au moins un compte.');
  const links = cleanLines(input.links ?? [], 10, 1000).filter((l) => /^https?:\/\//i.test(l));
  if (input.wishedAt && input.wishedAt.getTime() < now.getTime() + REQUEST_MIN_LEAD_MINUTES * 60_000) {
    throw new RefusedError('date_trop_proche', 'Choisissez une date à au moins une heure d’ici.');
  }
  const photos = input.photos ?? [];
  if (photos.length > MAX_PHOTOS_PER_POST) throw new RefusedError('too_many_images', `Au plus ${MAX_PHOTOS_PER_POST} photos.`);
  const checked = photos.map((photo, index) => {
    const result = checkImage(photo.bytes, photo.mime);
    if (!result.ok) throw new RefusedError(result.code, `Photo n°${index + 1} refusée.`);
    return { mime: result.mime, bytes: result.bytes };
  });

  return asUser(db, userId, async (trx) => {
    if (!canPropose(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('requestPost');
    await requireAccounts(trx, workspaceId, accountIds);
    const request = await trx
      .insertInto('post_requests')
      .values({ workspace_id: workspaceId, raw_text: rawText, title: cleanText(input.title, 300), details, links, wished_at: input.wishedAt ?? null, created_by: userId, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('request_accounts').values(accountIds.map((accountId) => ({ request_id: request.id, account_id: accountId, workspace_id: workspaceId }))).execute();
    for (const [index, photo] of checked.entries()) {
      const assetId = randomUUID();
      const storageKey = `${workspaceId}/demandes/${request.id}/${assetId}.${EXTENSIONS[photo.mime]}`;
      await media.write(storageKey, photo.bytes);
      await trx.insertInto('media_assets').values({ id: assetId, workspace_id: workspaceId, kind: 'upload', storage_key: storageKey, mime: photo.mime, bytes: photo.bytes.length }).execute();
      await trx.insertInto('request_photos').values({ request_id: request.id, asset_id: assetId, workspace_id: workspaceId, position: index + 1 }).execute();
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: 'demande.creee', entity: 'post_request', entityId: request.id, details: { accounts: accountIds.length, photos: checked.length }, at: now });
    return request.id;
  });
}

/** Demandes de l'espace, les plus récentes d'abord ; `mine` : celles de la personne seulement. */
export async function listPostRequests(db: Database, userId: string, workspaceId: string, options: { mine?: boolean; limit?: number } = {}): Promise<{ requests: PostRequest[]; canPropose: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    let query = trx
      .selectFrom('post_requests as r')
      .leftJoin('users as u', 'u.id', 'r.created_by')
      .select(['r.id', 'r.raw_text', 'r.title', 'r.details', 'r.links', 'r.wished_at', 'r.status', 'r.followup', 'r.created_by', 'r.created_at', 'u.full_name', 'u.email'])
      .where('r.workspace_id', '=', workspaceId)
      .orderBy('r.created_at', 'desc')
      .limit(options.limit ?? 50);
    if (options.mine) query = query.where('r.created_by', '=', userId);
    const rows = await query.execute();
    const ids = rows.map((r) => r.id);
    const accounts = ids.length === 0 ? [] : await trx.selectFrom('request_accounts').select(['request_id', 'account_id']).where('request_id', 'in', ids).execute();
    const photos = ids.length === 0 ? [] : await trx.selectFrom('request_photos').select('request_id').where('request_id', 'in', ids).execute();
    const posts =
      ids.length === 0
        ? []
        : await trx.selectFrom('posts').select(['id', 'request_id', 'account_id', 'status', 'scheduled_at']).where('request_id', 'in', ids).where('status', '<>', 'remplace').execute();
    return {
      canPropose: canPropose(role),
      requests: rows.map((r) => ({
        id: r.id,
        rawText: r.raw_text,
        title: r.title,
        details: r.details,
        links: r.links,
        wishedAt: r.wished_at,
        accountIds: accounts.filter((a) => a.request_id === r.id).map((a) => a.account_id),
        photoCount: photos.filter((p) => p.request_id === r.id).length,
        status: r.status as RequestStatus,
        followup: r.followup,
        authorName: r.full_name ?? r.email,
        isMine: r.created_by === userId,
        createdAt: r.created_at,
        posts: posts.filter((p) => p.request_id === r.id).map((p) => ({ id: p.id, accountId: p.account_id, status: p.status, scheduledAt: p.scheduled_at })),
      })),
    };
  });
}

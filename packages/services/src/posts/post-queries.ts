/**
 * Lectures pour l'interface : « Mes posts » (VAL-01), détail d'un post (VAL-02, VAL-09),
 * vue équipe de la semaine (VAL-07). Toujours sous l'identité de la personne (RLS).
 */
import {
  type PostCommandType,
  type PostStatus,
  addMinutes,
  availableCommands,
  departureSentence,
  findBlockingMarkers,
  type MarkerSpan,
} from '@posts-auto/core';
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import { canEditPost, canReschedulePost, loadAccess } from '../access.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import type { VisualTaskState } from '../visuals/visual-requests.ts';

export interface PostMedia {
  readonly assetId: string;
  readonly position: number;
  readonly altText: string | null;
  /** VIS-12 : image générée par IA, ou visuel qui en contient une. */
  readonly aiGenerated: boolean;
  readonly kind: 'upload' | 'generated' | 'rendered' | 'canva_export';
  /** VIS-10 : carrousel PDF plutôt qu'une image. */
  readonly isDocument: boolean;
  /** Visuel rendu à partir d'un modèle : ce qu'il faut savoir pour le relire (VIS-11, VIS-13). */
  readonly visual: VisualInfo | null;
}

export interface VisualInfo {
  /** D'où vient la photo du visuel ; null pour un visuel texte. */
  readonly photo: 'generated' | 'library' | 'kept' | 'avatar' | null;
  /** Problèmes de lisibilité relevés au rendu. */
  readonly issues: readonly string[];
  /** Remarques de préparation (budget atteint, générateur indisponible…). */
  readonly notes: readonly string[];
  readonly instruction: string | null;
}

const ISSUE_LABELS: Record<string, (zone: string) => string> = {
  text_truncated: (zone) => `Texte trop long, coupé (zone « ${zone} »)`,
  low_contrast: (zone) => `Contraste faible (zone « ${zone} »)`,
  empty_zone: (zone) => `Zone « ${zone} » restée vide`,
};

function visualInfo(content: unknown): VisualInfo {
  const c = (content ?? {}) as Record<string, unknown>;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  const issues = Array.isArray(c['issues']) ? (c['issues'] as { code?: unknown; zone?: unknown }[]) : [];
  return {
    photo: c['photo'] === 'generated' || c['photo'] === 'library' || c['photo'] === 'kept' || c['photo'] === 'avatar' ? c['photo'] : null,
    issues: issues.map((i) => ISSUE_LABELS[String(i.code)]?.(String(i.zone)) ?? String(i.code)),
    notes: strings(c['notes']),
    instruction: typeof c['instruction'] === 'string' ? c['instruction'] : null,
  };
}

export interface PostCard {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountKind: 'profile' | 'page';
  readonly status: PostStatus;
  readonly scheduledAt: Date;
  readonly timeZone: string;
  readonly body: string;
  readonly hasBlockingMarkers: boolean;
  /** VAL-04 : « Part demain à 12h ». */
  readonly departure: string;
  readonly media: readonly PostMedia[];
  /** La personne est titulaire ou déléguée sur le compte. */
  readonly isMine: boolean;
  readonly lastError: string | null;
}

/** Statuts montrés dans « Mes posts » : ce qui attend une décision ou va partir. */
const ACTIVE_STATUSES: readonly PostStatus[] = ['a_valider', 'valide', 'modif', 'refuse', 'en_publication', 'erreur'];

async function mediaOf(trx: Tx, postIds: readonly string[]): Promise<Map<string, PostMedia[]>> {
  const map = new Map<string, PostMedia[]>();
  if (postIds.length === 0) return map;
  const rows = await trx
    .selectFrom('post_media as pm')
    .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
    .select(['pm.post_id', 'pm.asset_id', 'pm.position', 'pm.alt_text', 'm.ai_generated', 'm.kind', 'm.render_content', 'm.mime'])
    .where('pm.post_id', 'in', postIds)
    .orderBy('pm.position')
    .execute();
  for (const row of rows) {
    const list = map.get(row.post_id) ?? [];
    list.push({
      assetId: row.asset_id,
      position: row.position,
      altText: row.alt_text,
      aiGenerated: row.ai_generated,
      kind: row.kind as PostMedia['kind'],
      isDocument: row.mime === 'application/pdf',
      visual: row.kind === 'rendered' && row.mime !== 'application/pdf' ? visualInfo(row.render_content) : null,
    });
    map.set(row.post_id, list);
  }
  return map;
}

function baseQuery(trx: Tx) {
  return trx
    .selectFrom('posts as p')
    .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
    .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
    .leftJoin('post_versions as v', 'v.id', 'p.current_version_id')
    .select([
      'p.id',
      'p.workspace_id',
      'w.name as workspace_name',
      'w.timezone',
      'p.account_id',
      'a.display_name',
      'a.kind as account_kind',
      'a.holder_user_id',
      'p.status',
      'p.scheduled_at',
      'p.original_scheduled_at',
      'p.reschedule_count',
      'p.published_at',
      'p.last_error',
      'v.body',
      'v.has_blocking_markers',
    ]);
}

type BaseRow = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

function toCard(row: BaseRow, media: PostMedia[], isMine: boolean, now: Date): PostCard {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    accountId: row.account_id,
    accountName: row.display_name ?? 'Compte LinkedIn',
    accountKind: row.account_kind as 'profile' | 'page',
    status: row.status,
    scheduledAt: row.scheduled_at,
    timeZone: row.timezone,
    body: row.body ?? '',
    hasBlockingMarkers: row.has_blocking_markers ?? false,
    departure: departureSentence(
      {
        status: row.status,
        scheduledAt: row.scheduled_at,
        originalScheduledAt: row.original_scheduled_at,
        rescheduleCount: row.reschedule_count,
        publishedAt: row.published_at,
      },
      now,
      row.timezone,
    ),
    media,
    isMine,
    lastError: row.last_error,
  };
}

/** VAL-01 : les posts des comptes dont la personne est titulaire ou déléguée, par heure de départ. */
export async function listMyPosts(db: Database, userId: string, now: Date): Promise<PostCard[]> {
  return asUser(db, userId, async (trx) => {
    const rows = await baseQuery(trx)
      .where('p.status', 'in', ACTIVE_STATUSES)
      .where('p.scheduled_at', '>=', addMinutes(now, -7 * 24 * 60))
      .where((eb) =>
        eb.or([
          eb('a.holder_user_id', '=', userId),
          eb.exists(
            eb.selectFrom('account_delegates as d').select('d.user_id').whereRef('d.account_id', '=', 'p.account_id').where('d.user_id', '=', userId),
          ),
        ]),
      )
      .orderBy('p.scheduled_at')
      .execute();
    const media = await mediaOf(trx, rows.map((row) => row.id));
    return rows.map((row) => toCard(row, media.get(row.id) ?? [], true, now));
  });
}

export interface PostVersion {
  readonly revision: number;
  readonly body: string;
  readonly authorKind: 'ai' | 'user';
  readonly authorName: string | null;
  readonly createdAt: Date;
}

export interface PostEvent {
  readonly at: Date;
  readonly fromStatus: PostStatus | null;
  readonly toStatus: PostStatus;
  readonly actorName: string | null;
  readonly reason: string | null;
}

/** GEN-06 : d'où vient le post, affiché avec lui. */
export interface PostOriginInfo {
  readonly label: string;
  readonly detail: string | null;
  readonly href: string | null;
  /** Le texte a été rédigé par l'IA (GEN-12). */
  readonly aiWritten: boolean;
  /** 1 : premier post ; 2, 3… : reprises (GEN-07). */
  readonly versionNo: number;
}

export interface PostDetail extends PostCard {
  readonly origin: PostOriginInfo;
  /** Marqueurs [À COMPLÉTER] / [À VÉRIFIER] à surligner (VAL-03). */
  readonly markers: readonly MarkerSpan[];
  readonly versions: readonly PostVersion[];
  /** VAL-09 : décisions, replanifications, reprises. */
  readonly history: readonly PostEvent[];
  readonly actions: {
    readonly commands: readonly PostCommandType[];
    readonly canEdit: boolean;
    readonly canReschedule: boolean;
    /** VIS-13 : refaire (ou ajouter) le visuel. */
    readonly canRedoVisual: boolean;
  };
  readonly url: string | null;
  /** PUB-09 : envoyé par e-mail pour publication manuelle ; le lien peut être ajouté ensuite. */
  readonly publishedManually: boolean;
  readonly canSetManualUrl: boolean;
  /** PUB-07 : premier commentaire et ce qu'il est devenu à la publication. */
  readonly firstComment: string | null;
  readonly firstCommentStatus: 'posted' | 'failed' | 'skipped' | null;
  readonly firstCommentError: string | null;
  /** VIS-13 : visuel demandé, en préparation ou en échec. */
  readonly visualTask: VisualTaskState | null;
}

export async function getPostDetail(db: Database, userId: string, postId: string, now: Date): Promise<PostDetail> {
  return asUser(db, userId, async (trx) => {
    const row = await baseQuery(trx).select(['p.external_post_url', 'p.published_manually', 'p.first_comment', 'p.first_comment_status', 'p.first_comment_error']).where('p.id', '=', postId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Post');
    const access = await loadAccess(trx, userId, row.workspace_id, row.account_id);
    const media = await mediaOf(trx, [row.id]);
    const versions = await trx
      .selectFrom('post_versions as v')
      .leftJoin('users as u', 'u.id', 'v.author_user_id')
      .select(['v.revision', 'v.body', 'v.author_kind', 'u.full_name', 'v.created_at'])
      .where('v.post_id', '=', postId)
      .orderBy('v.revision', 'desc')
      .execute();
    const history = await trx
      .selectFrom('post_status_history as h')
      .leftJoin('users as u', 'u.id', 'h.actor_user_id')
      .select(['h.at', 'h.from_status', 'h.to_status', 'u.full_name', 'h.reason'])
      .where('h.post_id', '=', postId)
      .orderBy('h.id', 'desc')
      .execute();

    const card = toCard(row, media.get(row.id) ?? [], access.relation !== 'none', now);
    const editableStatuses: readonly PostStatus[] = ['brouillon', 'a_valider', 'modif', 'valide', 'erreur'];
    const visualStatuses: readonly PostStatus[] = ['brouillon', 'a_valider', 'modif', 'valide'];
    const task = await trx
      .selectFrom('visual_tasks')
      .select(['instruction', 'photo_mode', 'failed_at', 'error', 'created_at'])
      .where('post_id', '=', postId)
      .executeTakeFirst();
    return {
      ...card,
      origin: await originOf(trx, postId, versions.some((v) => v.author_kind === 'ai')),
      markers: findBlockingMarkers(card.body),
      versions: versions.map((v) => ({
        revision: v.revision,
        body: v.body,
        authorKind: v.author_kind as 'ai' | 'user',
        authorName: v.full_name,
        createdAt: v.created_at,
      })),
      history: history.map((h) => ({ at: h.at, fromStatus: h.from_status, toStatus: h.to_status, actorName: h.full_name, reason: h.reason })),
      actions: {
        commands: availableCommands({ status: card.status, hasBlockingMarkers: card.hasBlockingMarkers }, access.actor),
        canEdit: canEditPost(access) && editableStatuses.includes(card.status),
        canReschedule: canReschedulePost(access) && (card.status === 'a_valider' || card.status === 'valide'),
        canRedoVisual: canEditPost(access) && visualStatuses.includes(card.status),
      },
      url: row.external_post_url,
      publishedManually: row.published_manually,
      firstComment: row.first_comment,
      firstCommentStatus: row.first_comment_status as 'posted' | 'failed' | 'skipped' | null,
      firstCommentError: row.first_comment_error,
      canSetManualUrl: row.published_manually && (access.relation === 'holder' || access.actor.kind === 'user' && access.actor.isWorkspaceManager),
      visualTask:
        task === undefined
          ? null
          : {
              status: task.failed_at === null ? 'pending' : 'failed',
              instruction: task.instruction,
              photoMode: task.photo_mode as VisualTaskState['photoMode'],
              error: task.error,
              requestedAt: task.created_at,
            },
    };
  });
}

/** GEN-06 : origine affichée (planning, idée, événement, demande, IA…), avec un lien vers la source. */
async function originOf(trx: Tx, postId: string, aiWritten: boolean): Promise<PostOriginInfo> {
  const p = await trx
    .selectFrom('posts as p')
    .leftJoin('planning_cells as c', 'c.id', 'p.planning_cell_id')
    .leftJoin('ideas as i', 'i.id', 'p.idea_id')
    .leftJoin('events as e', 'e.id', 'p.event_id')
    .leftJoin('post_requests as r', 'r.id', 'p.request_id')
    .leftJoin('users as ru', 'ru.id', 'r.created_by')
    .select([
      'p.workspace_id',
      'p.origin',
      'p.version_no',
      'p.source_note',
      'p.planning_cell_id',
      'p.subject_id',
      'c.content as cell_content',
      'c.week_start as cell_week',
      'c.account_id as cell_account',
      'i.title as idea_title',
      'e.title as event_title',
      'ru.full_name as requester',
    ])
    .where('p.id', '=', postId)
    .executeTakeFirstOrThrow();
  const ws = encodeURIComponent(p.workspace_id);
  const base = { aiWritten, versionNo: p.version_no };
  switch (p.origin) {
    case 'planning':
      if (p.planning_cell_id !== null && p.cell_week !== null) {
        return {
          ...base,
          label: 'Planning',
          detail: p.cell_content,
          href: p.cell_account ? `/planning/${ws}/case?ligne=${encodeURIComponent(`compte:${p.cell_account}`)}&semaine=${p.cell_week}` : `/planning/${ws}`,
        };
      }
      return { ...base, label: p.subject_id !== null ? 'Banque de sujets' : 'Planning', detail: p.source_note, href: p.subject_id !== null ? `/planning/${ws}/banque` : null };
    case 'event':
      return { ...base, label: 'Événement', detail: p.event_title ?? p.source_note, href: `/planning/${ws}/evenements` };
    case 'team_idea':
      return { ...base, label: 'Idée de l’équipe', detail: p.idea_title ?? p.source_note, href: `/idees/${ws}?vue=utilisees` };
    case 'ai_reserve':
      return { ...base, label: 'Réserve de l’IA', detail: p.idea_title ?? p.source_note, href: null };
    case 'ai_idea':
      return { ...base, label: 'Idée de l’IA', detail: p.source_note, href: null };
    case 'request':
      return { ...base, label: 'Demande ponctuelle', detail: p.requester ? `de ${p.requester}` : p.source_note, href: `/demandes/${ws}?toutes=1` };
    default:
      return { ...base, label: 'Source externe', detail: p.source_note, href: null };
  }
}

export interface TeamWeekAccount {
  readonly accountId: string;
  readonly accountName: string;
  readonly holderName: string | null;
  readonly posts: readonly PostCard[];
}

/** VAL-07 : tous les posts de la semaine, par compte, avec leur statut. */
export async function teamWeek(db: Database, userId: string, workspaceId: string, weekStart: string, now: Date): Promise<TeamWeekAccount[]> {
  return asUser(db, userId, async (trx) => {
    const accounts = await trx
      .selectFrom('social_accounts as a')
      .leftJoin('users as u', 'u.id', 'a.holder_user_id')
      .select(['a.id', 'a.display_name', 'u.full_name'])
      .where('a.workspace_id', '=', workspaceId)
      .where('a.status', '<>', 'revoked')
      .orderBy('a.display_name')
      .execute();
    const rows = await baseQuery(trx)
      .where('p.workspace_id', '=', workspaceId)
      .where('p.week_start', '=', weekStart)
      .where('p.status', 'not in', ['remplace'])
      .orderBy('p.scheduled_at')
      .execute();
    const media = await mediaOf(trx, rows.map((row) => row.id));
    const delegated = await trx
      .selectFrom('account_delegates')
      .select('account_id')
      .where('user_id', '=', userId)
      .where('workspace_id', '=', workspaceId)
      .execute();
    const delegatedAccounts = new Set(delegated.map((d) => d.account_id));
    return accounts.map((account) => ({
      accountId: account.id,
      accountName: account.display_name ?? 'Compte LinkedIn',
      holderName: account.full_name,
      posts: rows
        .filter((row) => row.account_id === account.id)
        .map((row) => toCard(row, media.get(row.id) ?? [], row.holder_user_id === userId || delegatedAccounts.has(row.account_id), now)),
    }));
  });
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly role: string | null;
}

/** Espaces accessibles à la personne (la RLS ne renvoie que ceux-là). */
export async function listMyWorkspaces(db: Database, userId: string): Promise<WorkspaceSummary[]> {
  return asUser(db, userId, async (trx) => {
    const rows = await trx
      .selectFrom('workspaces as w')
      .leftJoin('workspace_members as m', (join) => join.onRef('m.workspace_id', '=', 'w.id').on('m.user_id', '=', userId))
      .select(['w.id', 'w.name', 'm.role'])
      .orderBy('w.name')
      .execute();
    return rows.map((row) => ({ id: row.id, name: row.name, role: row.role }));
  });
}

/** Image d'un post, si la personne peut voir le post (sert l'affichage des visuels). */
export async function findMediaForUser(db: Database, userId: string, assetId: string): Promise<{ storageKey: string; mime: string } | null> {
  return asUser(db, userId, async (trx) => {
    const row = await trx
      .selectFrom('media_assets')
      .select(['storage_key', 'mime'])
      .where('id', '=', assetId)
      .executeTakeFirst();
    return row === undefined ? null : { storageKey: row.storage_key, mime: row.mime };
  });
}

const LINKEDIN_POST_URL = /^https:\/\/(www\.)?linkedin\.com\/(feed\/update|posts)\/[\w:%.\-/]+$/;

/** PUB-09 : lien du post publié à la main, ajouté par le titulaire ou un administrateur. */
export async function setManualPostUrl(db: Database, userId: string, postId: string, rawUrl: string, now: Date): Promise<void> {
  const url = rawUrl.trim().split('?')[0] ?? '';
  if (!LINKEDIN_POST_URL.test(url)) throw new RefusedError('lien_linkedin_invalide', 'Collez le lien du post tel que LinkedIn l’affiche (linkedin.com/posts/… ou linkedin.com/feed/update/…).');
  const post = await asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('posts').select(['workspace_id', 'account_id', 'published_manually']).where('id', '=', postId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Post');
    const access = await loadAccess(trx, userId, row.workspace_id, row.account_id);
    if (!row.published_manually) throw new RefusedError('pas_manuel', 'Ce post n’a pas été envoyé pour publication manuelle.');
    if (access.relation !== 'holder' && !(access.actor.kind === 'user' && access.actor.isWorkspaceManager)) throw new ForbiddenError('setManualUrl');
    return row;
  });
  await asSystem(db, async (trx) => {
    await trx.updateTable('posts').set({ external_post_url: url }).where('id', '=', postId).execute();
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', post.workspace_id).executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({ org_id: ws.org_id, workspace_id: post.workspace_id, actor_user_id: userId, actor_kind: 'user', action: 'post.lien_manuel', entity: 'post', entity_id: postId, details: JSON.stringify({ url }), at: now })
      .execute();
  });
}

/** PUB-07 : premier commentaire publié juste après le post (vide : aucun). */
export async function setFirstComment(db: Database, userId: string, postId: string, rawText: string, now: Date): Promise<void> {
  const text = rawText.replace(/\r\n/g, '\n').trim();
  if (text.length > 1250) throw new RefusedError('commentaire_trop_long', 'Le commentaire doit faire 1 250 caractères au plus.');
  const post = await asUser(db, userId, async (trx) => {
    const row = await trx.selectFrom('posts').select(['workspace_id', 'account_id', 'status']).where('id', '=', postId).executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Post');
    const access = await loadAccess(trx, userId, row.workspace_id, row.account_id);
    if (!canEditPost(access)) throw new ForbiddenError('firstComment');
    if (!['brouillon', 'a_valider', 'modif', 'valide', 'erreur'].includes(row.status)) throw new RefusedError('post_parti', 'Ce post est déjà publié ou en cours de publication.');
    return row;
  });
  await asSystem(db, async (trx) => {
    await trx.updateTable('posts').set({ first_comment: text === '' ? null : text }).where('id', '=', postId).execute();
    const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', post.workspace_id).executeTakeFirstOrThrow();
    await trx
      .insertInto('audit_log')
      .values({ org_id: ws.org_id, workspace_id: post.workspace_id, actor_user_id: userId, actor_kind: 'user', action: 'post.premier_commentaire', entity: 'post', entity_id: postId, details: JSON.stringify({ length: text.length }), at: now })
      .execute();
  });
}

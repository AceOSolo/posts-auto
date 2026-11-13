/**
 * Planning éditorial (PLA-01, PLA-02, PLA-05, PLA-07, PLA-08) : comptes × semaines, une
 * ligne par sujet, état calculé à partir des posts qui en sont issus.
 *
 * Lecture : tous les membres de l'espace (un contributeur « voit le planning »).
 * Écriture : propriétaire, administrateurs, éditeurs (matrice 3.3).
 */
import { type CellStatus, type PlannedEntry, type PostStatus, addDays, cellStatus, isoWeekNumber } from '@posts-auto/core';
import { type Database, type Tx, asUser, calendarOf, weekStartOf } from '@posts-auto/db';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

/** Ligne du planning : un compte, ou une ligne libre (événements, autre canal). */
export type RowKey = { readonly kind: 'account'; readonly accountId: string } | { readonly kind: 'event' | 'channel'; readonly label: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Forme lisible dans une adresse : « compte:<id> », « evenement:<libellé> », « canal:<libellé> ». */
export function rowKeyToString(key: RowKey): string {
  return key.kind === 'account' ? `compte:${key.accountId}` : `${key.kind === 'event' ? 'evenement' : 'canal'}:${key.label}`;
}

export function parseRowKey(value: string): RowKey | null {
  const [prefix, ...rest] = value.split(':');
  const tail = rest.join(':').trim();
  if (prefix === 'compte' && UUID.test(tail)) return { kind: 'account', accountId: tail };
  if ((prefix === 'evenement' || prefix === 'canal') && tail !== '' && tail.length <= 100) return { kind: prefix === 'evenement' ? 'event' : 'channel', label: tail };
  return null;
}

/** Lundi valide (AAAA-MM-JJ) ? */
export function isMonday(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date && d.getUTCDay() === 1;
}

export interface EntryPost {
  readonly id: string;
  readonly status: PostStatus;
  readonly scheduledAt: Date;
}

export interface PlanningEntry {
  readonly id: string;
  readonly row: RowKey;
  readonly weekStart: string;
  readonly position: number;
  readonly content: string;
  readonly subjectId: string | null;
  readonly setAsideReason: string | null;
  readonly status: CellStatus;
  /** PLA-07 : posts issus de ce sujet (reprises comprises). */
  readonly posts: readonly EntryPost[];
}

export interface PlanningRow {
  readonly key: string;
  readonly row: RowKey;
  readonly label: string;
}

export interface PlanningWeek {
  readonly weekStart: string;
  readonly isoWeek: number;
}

async function requireRole(trx: Tx, userId: string, workspaceId: string) {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

async function requireEditor(trx: Tx, userId: string, workspaceId: string): Promise<void> {
  if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editPlanning');
}

/** Semaine en cours dans le fuseau de l'espace. */
export async function currentWeekOf(trx: Tx, workspaceId: string, now: Date): Promise<string> {
  const settings = await trx
    .selectFrom('workspaces')
    .select(['timezone', 'allowed_hours', 'holidays_calendar', 'slot_step_minutes', 'max_posts_per_account_per_day', 'min_gap_minutes', 'max_posts_per_slot'])
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  return weekStartOf(now, calendarOf(settings));
}

type EntryRow = {
  id: string;
  row_kind: string;
  account_id: string | null;
  row_label: string | null;
  week_start: string;
  position: number;
  content: string;
  subject_id: string | null;
  set_aside_reason: string | null;
};

const ENTRY_COLUMNS = ['id', 'row_kind', 'account_id', 'row_label', 'week_start', 'position', 'content', 'subject_id', 'set_aside_reason'] as const;

function rowOf(entry: EntryRow): RowKey {
  return entry.row_kind === 'account'
    ? { kind: 'account', accountId: entry.account_id as string }
    : { kind: entry.row_kind as 'event' | 'channel', label: entry.row_label as string };
}

async function withPosts(trx: Tx, rows: readonly EntryRow[]): Promise<PlanningEntry[]> {
  const ids = rows.map((r) => r.id);
  const posts =
    ids.length === 0
      ? []
      : await trx
          .selectFrom('posts')
          .select(['id', 'planning_cell_id', 'status', 'scheduled_at'])
          .where('planning_cell_id', 'in', ids)
          .orderBy('version_no')
          .execute();
  return rows.map((entry) => {
    const own = posts.filter((p) => p.planning_cell_id === entry.id).map((p) => ({ id: p.id, status: p.status, scheduledAt: p.scheduled_at }));
    return {
      id: entry.id,
      row: rowOf(entry),
      weekStart: entry.week_start,
      position: entry.position,
      content: entry.content,
      subjectId: entry.subject_id,
      setAsideReason: entry.set_aside_reason,
      status: cellStatus(entry.set_aside_reason !== null, own.map((p) => p.status)),
      posts: own,
    };
  });
}

export interface PlanningGrid {
  readonly weeks: readonly PlanningWeek[];
  readonly rows: readonly PlanningRow[];
  /** Sujets par case : clé « ligne|semaine ». */
  readonly entries: Readonly<Record<string, readonly PlanningEntry[]>>;
  readonly currentWeek: string;
  readonly canEdit: boolean;
}

export const cellKey = (row: RowKey, weekStart: string) => `${rowKeyToString(row)}|${weekStart}`;

/** PLA-01 : vue comptes × semaines. Les comptes actifs ont toujours leur ligne ; les lignes libres apparaissent quand elles ont un sujet. */
export async function planningGrid(
  db: Database,
  userId: string,
  workspaceId: string,
  options: { from?: string; weeks?: number; accountId?: string },
  now: Date,
): Promise<PlanningGrid> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    const currentWeek = await currentWeekOf(trx, workspaceId, now);
    const from = options.from !== undefined && isMonday(options.from) ? options.from : currentWeek;
    const count = Math.min(Math.max(options.weeks ?? 13, 1), 53);
    const weeks = Array.from({ length: count }, (_, i) => addDays(from, 7 * i)).map((weekStart) => ({ weekStart, isoWeek: isoWeekNumber(weekStart) }));
    const until = addDays(from, 7 * count);

    let accountsQuery = trx
      .selectFrom('social_accounts')
      .select(['id', 'display_name', 'kind'])
      .where('workspace_id', '=', workspaceId)
      .where('status', '<>', 'revoked')
      .orderBy('kind', 'desc')
      .orderBy('display_name');
    if (options.accountId !== undefined) accountsQuery = accountsQuery.where('id', '=', options.accountId);
    const accounts = await accountsQuery.execute();

    let entriesQuery = trx
      .selectFrom('planning_cells')
      .select([...ENTRY_COLUMNS])
      .where('workspace_id', '=', workspaceId)
      .where('week_start', '>=', from)
      .where('week_start', '<', until)
      .orderBy('position');
    if (options.accountId !== undefined) entriesQuery = entriesQuery.where('account_id', '=', options.accountId);
    const entries = await withPosts(trx, await entriesQuery.execute());

    const rows: PlanningRow[] = accounts.map((a) => {
      const row: RowKey = { kind: 'account', accountId: a.id };
      return { key: rowKeyToString(row), row, label: a.display_name ?? 'Compte' };
    });
    for (const entry of entries) {
      if (entry.row.kind === 'account') continue;
      const key = rowKeyToString(entry.row);
      if (!rows.some((r) => r.key === key)) rows.push({ key, row: entry.row, label: entry.row.label });
    }
    const byCell: Record<string, PlanningEntry[]> = {};
    for (const entry of entries) (byCell[cellKey(entry.row, entry.weekStart)] ??= []).push(entry);
    return { weeks, rows, entries: byCell, currentWeek, canEdit: canManageContent(role) };
  });
}

async function rowLabel(trx: Tx, workspaceId: string, row: RowKey): Promise<string> {
  if (row.kind !== 'account') return row.label;
  const account = await trx
    .selectFrom('social_accounts')
    .select('display_name')
    .where('id', '=', row.accountId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (account === undefined) throw new NotFoundError('Compte');
  return account.display_name ?? 'Compte';
}

function rowFilter(row: RowKey) {
  return row.kind === 'account'
    ? { row_kind: 'account' as const, account_id: row.accountId, row_label: null }
    : { row_kind: row.kind, account_id: null, row_label: row.label };
}

export interface PlanningCell {
  readonly row: RowKey;
  readonly label: string;
  readonly weekStart: string;
  readonly isoWeek: number;
  readonly entries: readonly PlanningEntry[];
  readonly canEdit: boolean;
}

export async function getPlanningCell(db: Database, userId: string, workspaceId: string, row: RowKey, weekStart: string): Promise<PlanningCell> {
  if (!isMonday(weekStart)) throw new NotFoundError('Semaine');
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    const label = await rowLabel(trx, workspaceId, row);
    const f = rowFilter(row);
    let query = trx
      .selectFrom('planning_cells')
      .select([...ENTRY_COLUMNS])
      .where('workspace_id', '=', workspaceId)
      .where('row_kind', '=', f.row_kind)
      .where('week_start', '=', weekStart)
      .orderBy('position');
    query = f.account_id === null ? query.where('row_label', '=', f.row_label as string) : query.where('account_id', '=', f.account_id);
    return { row, label, weekStart, isoWeek: isoWeekNumber(weekStart), entries: await withPosts(trx, await query.execute()), canEdit: canManageContent(role) };
  });
}

async function insertEntry(trx: Tx, workspaceId: string, userId: string, row: RowKey, weekStart: string, content: string, extra: { subjectId?: string | null; sourceRef?: string | null }): Promise<string> {
  const f = rowFilter(row);
  let last = trx
    .selectFrom('planning_cells')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('workspace_id', '=', workspaceId)
    .where('row_kind', '=', f.row_kind)
    .where('week_start', '=', weekStart);
  last = f.account_id === null ? last.where('row_label', '=', f.row_label as string) : last.where('account_id', '=', f.account_id);
  const max = (await last.executeTakeFirst())?.max;
  const inserted = await trx
    .insertInto('planning_cells')
    .values({
      workspace_id: workspaceId,
      ...f,
      week_start: weekStart,
      position: Number(max ?? 0) + 1,
      content,
      subject_id: extra.subjectId ?? null,
      source_ref: extra.sourceRef ?? null,
      created_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

/** Ajoute un sujet à une case (PLA-02). */
export async function addPlanningEntry(db: Database, userId: string, workspaceId: string, row: RowKey, weekStart: string, content: string, now: Date): Promise<string> {
  const text = cleanText(content, 500);
  if (text === null) throw new RefusedError('sujet_requis', 'Écrivez le sujet.');
  if (!isMonday(weekStart)) throw new RefusedError('semaine_invalide', 'Semaine invalide.');
  return asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    await rowLabel(trx, workspaceId, row);
    const id = await insertEntry(trx, workspaceId, userId, row, weekStart, text, {});
    await audit(trx, { workspaceId, actorUserId: userId, action: 'planning.sujet_ajoute', entity: 'planning_cell', entityId: id, details: { row: rowKeyToString(row), weekStart }, at: now });
    return id;
  });
}

async function requireEntry(trx: Tx, workspaceId: string, entryId: string) {
  const entry = await trx.selectFrom('planning_cells').select(['id', 'content']).where('id', '=', entryId).where('workspace_id', '=', workspaceId).executeTakeFirst();
  if (entry === undefined) throw new NotFoundError('Sujet');
  return entry;
}

export async function updatePlanningEntry(db: Database, userId: string, workspaceId: string, entryId: string, content: string, now: Date): Promise<void> {
  const text = cleanText(content, 500);
  if (text === null) throw new RefusedError('sujet_requis', 'Écrivez le sujet.');
  await asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    await requireEntry(trx, workspaceId, entryId);
    await trx.updateTable('planning_cells').set({ content: text }).where('id', '=', entryId).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'planning.sujet_modifie', entity: 'planning_cell', entityId: entryId, details: {}, at: now });
  });
}

/** Un sujet déjà rédigé ne se supprime pas (le lien avec son post serait perdu, PLA-07) : il se met de côté. */
export async function deletePlanningEntry(db: Database, userId: string, workspaceId: string, entryId: string, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    const entry = await requireEntry(trx, workspaceId, entryId);
    const post = await trx.selectFrom('posts').select('id').where('planning_cell_id', '=', entryId).executeTakeFirst();
    if (post !== undefined) throw new RefusedError('sujet_deja_redige', 'Ce sujet a déjà donné un post : mettez-le de côté plutôt que de le supprimer.');
    await trx.deleteFrom('planning_cells').where('id', '=', entryId).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'planning.sujet_supprime', entity: 'planning_cell', entityId: entryId, details: { content: entry.content }, at: now });
  });
}

/** PLA-02 : « mis de côté », avec un motif ; `null` le remet dans le planning. */
export async function setAsidePlanningEntry(db: Database, userId: string, workspaceId: string, entryId: string, reason: string | null, now: Date): Promise<void> {
  const text = reason === null ? null : cleanText(reason, 500);
  if (reason !== null && text === null) throw new RefusedError('motif_requis', 'Indiquez pourquoi le sujet est mis de côté.');
  await asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    await requireEntry(trx, workspaceId, entryId);
    await trx
      .updateTable('planning_cells')
      .set({ set_aside_at: text === null ? null : now, set_aside_reason: text })
      .where('id', '=', entryId)
      .execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: text === null ? 'planning.sujet_repris' : 'planning.sujet_mis_de_cote', entity: 'planning_cell', entityId: entryId, details: { reason: text }, at: now });
  });
}

export interface InventoryItem extends PlanningEntry {
  readonly label: string;
}

/** PLA-08 : sujets des semaines en cours et suivante, avec leur post ou leur motif de mise de côté ; ceux qui demandent une action d'abord. */
export async function weekInventory(db: Database, userId: string, workspaceId: string, now: Date): Promise<{ weeks: readonly string[]; items: readonly InventoryItem[] }> {
  return asUser(db, userId, async (trx) => {
    await requireRole(trx, userId, workspaceId);
    const current = await currentWeekOf(trx, workspaceId, now);
    const weeks = [current, addDays(current, 7)];
    const rows = await trx
      .selectFrom('planning_cells as c')
      .leftJoin('social_accounts as a', 'a.id', 'c.account_id')
      .select(['c.id', 'c.row_kind', 'c.account_id', 'c.row_label', 'c.week_start', 'c.position', 'c.content', 'c.subject_id', 'c.set_aside_reason', 'a.display_name'])
      .where('c.workspace_id', '=', workspaceId)
      .where('c.week_start', 'in', weeks)
      .orderBy('c.week_start')
      .orderBy('a.display_name')
      .orderBy('c.position')
      .execute();
    const entries = await withPosts(trx, rows);
    const items = entries.map((entry, i) => ({ ...entry, label: rows[i]?.display_name ?? (entry.row.kind === 'account' ? 'Compte' : entry.row.label) }));
    const priority = (item: InventoryItem) => (item.status.needsAttention ? 0 : item.status.state === 'planned' ? 1 : 2);
    return { weeks, items: items.sort((a, b) => priority(a) - priority(b)) };
  });
}

/** PLA-05 : crée les sujets d'un import ; un sujet déjà présent dans la même case n'est pas recréé. */
export async function importPlanning(db: Database, userId: string, workspaceId: string, entries: readonly PlannedEntry[], now: Date): Promise<{ created: number; skipped: number }> {
  return asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    const accountIds = new Set(
      (await trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', workspaceId).execute()).map((a) => a.id),
    );
    const existing = await trx.selectFrom('planning_cells').select(['row_kind', 'account_id', 'row_label', 'week_start', 'content']).where('workspace_id', '=', workspaceId).execute();
    const seen = new Set(existing.map((e) => `${e.row_kind}|${e.account_id ?? e.row_label}|${e.week_start}|${e.content.trim().toLowerCase()}`));
    let created = 0;
    let skipped = 0;
    for (const entry of entries) {
      const row: RowKey = entry.rowKind === 'account' ? { kind: 'account', accountId: entry.accountId as string } : { kind: entry.rowKind, label: entry.rowLabel as string };
      const key = `${entry.rowKind}|${entry.accountId ?? entry.rowLabel}|${entry.weekStart}|${entry.content.trim().toLowerCase()}`;
      if (seen.has(key) || !isMonday(entry.weekStart) || (row.kind === 'account' && !accountIds.has(row.accountId))) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      await insertEntry(trx, workspaceId, userId, row, entry.weekStart, entry.content, { sourceRef: entry.sourceRef });
      created += 1;
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: 'planning.import', entity: 'workspace', entityId: workspaceId, details: { created, skipped }, at: now });
    return { created, skipped };
  });
}

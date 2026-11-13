/**
 * Banque de sujets (PLA-03) et événements à relayer (PLA-04).
 *
 * Lecture : tous les membres de l'espace. Écriture : gestion du contenu (matrice 3.3).
 */
import { type PostStatus, RECURRENCES, type Recurrence, type SubjectRow } from '@posts-auto/core';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { isMonday } from './planning.ts';

async function requireRole(trx: Tx, userId: string, workspaceId: string) {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

async function requireEditor(trx: Tx, userId: string, workspaceId: string): Promise<void> {
  if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editPlanning');
}

async function requireAccounts(trx: Tx, workspaceId: string, accountIds: readonly string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const found = await trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', workspaceId).where('id', 'in', [...accountIds]).execute();
  if (found.length !== new Set(accountIds).size) throw new RefusedError('compte_inconnu', 'Compte inconnu dans cet espace.');
}

// --- Banque de sujets ---

export interface BankSubject {
  readonly id: string;
  readonly accountId: string | null;
  readonly subject: string;
  readonly theme: string | null;
  readonly angle: string | null;
  readonly format: string | null;
  readonly offer: string | null;
  readonly audience: string | null;
  readonly published: boolean;
  /** Un post en est déjà issu. */
  readonly used: boolean;
}

export type BankSubjectInput = Omit<BankSubject, 'id' | 'used' | 'published'> & { readonly published?: boolean };

/** `accountId` : les sujets de ce compte et ceux communs à l'espace ; absent : toute la banque. */
export async function listSubjects(db: Database, userId: string, workspaceId: string, accountId?: string): Promise<{ subjects: BankSubject[]; canEdit: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    let query = trx
      .selectFrom('subject_bank as s')
      .select(['s.id', 's.account_id', 's.subject', 's.theme', 's.angle', 's.format', 's.offer', 's.audience', 's.published'])
      .select((eb) => eb.exists(eb.selectFrom('posts as p').select('p.id').whereRef('p.subject_id', '=', 's.id')).as('used'))
      .where('s.workspace_id', '=', workspaceId)
      .orderBy('s.published')
      .orderBy('s.position')
      .orderBy('s.created_at');
    if (accountId !== undefined) query = query.where((eb) => eb.or([eb('s.account_id', '=', accountId), eb('s.account_id', 'is', null)]));
    const rows = await query.execute();
    return {
      canEdit: canManageContent(role),
      subjects: rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        subject: r.subject,
        theme: r.theme,
        angle: r.angle,
        format: r.format,
        offer: r.offer,
        audience: r.audience,
        published: r.published,
        used: Boolean(r.used),
      })),
    };
  });
}

function subjectValues(input: BankSubjectInput) {
  const subject = cleanText(input.subject, 500);
  if (subject === null) throw new RefusedError('sujet_requis', 'Écrivez le sujet.');
  return {
    account_id: input.accountId,
    subject,
    theme: cleanText(input.theme, 200),
    angle: cleanText(input.angle, 500),
    format: cleanText(input.format, 100),
    offer: cleanText(input.offer, 200),
    audience: cleanText(input.audience, 200),
    ...(input.published !== undefined && { published: input.published }),
  };
}

export async function saveSubject(db: Database, userId: string, workspaceId: string, subjectId: string | null, input: BankSubjectInput, now: Date): Promise<string> {
  const values = subjectValues(input);
  return asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    await requireAccounts(trx, workspaceId, input.accountId === null ? [] : [input.accountId]);
    let id: string;
    if (subjectId === null) {
      const max = await trx.selectFrom('subject_bank').select((eb) => eb.fn.max('position').as('max')).where('workspace_id', '=', workspaceId).executeTakeFirst();
      id = (
        await trx
          .insertInto('subject_bank')
          .values({ workspace_id: workspaceId, position: Number(max?.max ?? 0) + 1, created_by: userId, ...values })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    } else {
      const row = await trx.updateTable('subject_bank').set(values).where('id', '=', subjectId).where('workspace_id', '=', workspaceId).returning('id').executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Sujet');
      id = row.id;
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: subjectId === null ? 'banque.sujet_ajoute' : 'banque.sujet_modifie', entity: 'subject_bank', entityId: id, details: {}, at: now });
    return id;
  });
}

export async function deleteSubject(db: Database, userId: string, workspaceId: string, subjectId: string, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    const row = await trx.deleteFrom('subject_bank').where('id', '=', subjectId).where('workspace_id', '=', workspaceId).returning('subject').executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Sujet');
    await audit(trx, { workspaceId, actorUserId: userId, action: 'banque.sujet_supprime', entity: 'subject_bank', entityId: subjectId, details: { subject: row.subject }, at: now });
  });
}

/** PLA-03 : « glisser » un sujet de la banque vers une case du planning (sans JavaScript : choisir le compte et la semaine). */
export async function placeSubject(db: Database, userId: string, workspaceId: string, subjectId: string, accountId: string, weekStart: string, now: Date): Promise<string> {
  if (!isMonday(weekStart)) throw new RefusedError('semaine_invalide', 'Semaine invalide.');
  return asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    const subject = await trx.selectFrom('subject_bank').select(['subject', 'account_id']).where('id', '=', subjectId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (subject === undefined) throw new NotFoundError('Sujet');
    if (subject.account_id !== null && subject.account_id !== accountId) throw new RefusedError('autre_compte', 'Ce sujet appartient à la banque d’un autre compte.');
    await requireAccounts(trx, workspaceId, [accountId]);
    const max = await trx
      .selectFrom('planning_cells')
      .select((eb) => eb.fn.max('position').as('max'))
      .where('workspace_id', '=', workspaceId)
      .where('row_kind', '=', 'account')
      .where('account_id', '=', accountId)
      .where('week_start', '=', weekStart)
      .executeTakeFirst();
    const cell = await trx
      .insertInto('planning_cells')
      .values({
        workspace_id: workspaceId,
        row_kind: 'account',
        account_id: accountId,
        week_start: weekStart,
        position: Number(max?.max ?? 0) + 1,
        content: subject.subject,
        subject_id: subjectId,
        created_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'banque.sujet_place', entity: 'planning_cell', entityId: cell.id, details: { subjectId, weekStart }, at: now });
    return cell.id;
  });
}

/** Import d'une banque de sujets ; un sujet déjà présent pour le même compte n'est pas recréé. */
export async function importSubjects(db: Database, userId: string, workspaceId: string, accountId: string | null, rows: readonly SubjectRow[], now: Date): Promise<{ created: number; skipped: number }> {
  return asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    await requireAccounts(trx, workspaceId, accountId === null ? [] : [accountId]);
    let query = trx.selectFrom('subject_bank').select('subject').where('workspace_id', '=', workspaceId);
    query = accountId === null ? query.where('account_id', 'is', null) : query.where('account_id', '=', accountId);
    const seen = new Set((await query.execute()).map((r) => r.subject.trim().toLowerCase()));
    const max = await trx.selectFrom('subject_bank').select((eb) => eb.fn.max('position').as('max')).where('workspace_id', '=', workspaceId).executeTakeFirst();
    let position = Number(max?.max ?? 0);
    let created = 0;
    let skipped = 0;
    for (const row of rows) {
      const key = row.subject.trim().toLowerCase();
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      position += 1;
      await trx
        .insertInto('subject_bank')
        .values({ workspace_id: workspaceId, position, created_by: userId, source_ref: row.sourceRef, ...subjectValues({ ...row, accountId }) })
        .execute();
      created += 1;
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: 'banque.import', entity: 'workspace', entityId: workspaceId, details: { accountId, created, skipped }, at: now });
    return { created, skipped };
  });
}

// --- Événements ---

export interface PlannedEvent {
  readonly id: string;
  readonly title: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly link: string | null;
  readonly details: string | null;
  /** EDI-08 : récurrence de l'événement modèle ; ses occurrences ont un `seriesId`. */
  readonly recurrence: Recurrence;
  readonly recurrenceUntil: string | null;
  readonly seriesId: string | null;
  readonly accountIds: readonly string[];
  /** Posts qui relaient l'événement. */
  readonly relays: readonly { readonly postId: string; readonly accountId: string; readonly status: PostStatus }[];
}

export interface EventInput {
  readonly title: string;
  readonly startsOn: string;
  readonly endsOn?: string | null;
  readonly link?: string | null;
  readonly details?: string | null;
  readonly recurrence?: Recurrence;
  readonly recurrenceUntil?: string | null;
  readonly accountIds: readonly string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: string) => ISO_DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** `since` : n'affiche que les événements qui ne sont pas terminés à cette date (et les rendez-vous récurrents, toujours modifiables). */
export async function listEvents(db: Database, userId: string, workspaceId: string, since?: string): Promise<{ events: PlannedEvent[]; canEdit: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    let query = trx
      .selectFrom('events')
      .select(['id', 'title', 'starts_on', 'ends_on', 'link', 'details', 'recurrence', 'recurrence_until', 'series_id'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('starts_on');
    if (since !== undefined) query = query.where((eb) => eb.or([eb(eb.fn.coalesce('ends_on', 'starts_on'), '>=', since), eb('recurrence', '<>', 'none')]));
    const events = await query.execute();
    const ids = events.map((e) => e.id);
    const links = ids.length === 0 ? [] : await trx.selectFrom('event_accounts').select(['event_id', 'account_id']).where('event_id', 'in', ids).execute();
    const relays = ids.length === 0 ? [] : await trx.selectFrom('posts').select(['id', 'event_id', 'account_id', 'status']).where('event_id', 'in', ids).where('status', '<>', 'remplace').execute();
    return {
      canEdit: canManageContent(role),
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        startsOn: e.starts_on,
        endsOn: e.ends_on,
        link: e.link,
        details: e.details,
        recurrence: e.recurrence as Recurrence,
        recurrenceUntil: e.recurrence_until,
        seriesId: e.series_id,
        accountIds: links.filter((l) => l.event_id === e.id).map((l) => l.account_id),
        relays: relays.filter((r) => r.event_id === e.id).map((r) => ({ postId: r.id, accountId: r.account_id, status: r.status })),
      })),
    };
  });
}

export async function saveEvent(db: Database, userId: string, workspaceId: string, eventId: string | null, input: EventInput, now: Date): Promise<string> {
  const title = cleanText(input.title, 300);
  if (title === null) throw new RefusedError('titre_requis', 'Donnez un titre à l’événement.');
  if (!validDate(input.startsOn)) throw new RefusedError('date_invalide', 'Date invalide.');
  const endsOn = input.endsOn === undefined || input.endsOn === null || input.endsOn === '' ? null : input.endsOn;
  if (endsOn !== null && (!validDate(endsOn) || endsOn < input.startsOn)) throw new RefusedError('date_fin_invalide', 'La fin doit être le même jour ou après le début.');
  const accountIds = [...new Set(input.accountIds)];
  const recurrence = input.recurrence ?? 'none';
  if (!RECURRENCES.includes(recurrence)) throw new RefusedError('recurrence_invalide', 'Récurrence inconnue.');
  const until = recurrence === 'none' || !input.recurrenceUntil ? null : input.recurrenceUntil;
  if (until !== null && (!validDate(until) || until < input.startsOn)) throw new RefusedError('date_fin_invalide', 'La fin de la récurrence doit être après le premier rendez-vous.');
  const values = { title, starts_on: input.startsOn, ends_on: endsOn, link: cleanText(input.link, 1000), details: cleanText(input.details, 4000), recurrence, recurrence_until: until };
  return asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    await requireAccounts(trx, workspaceId, accountIds);
    let id: string;
    if (eventId === null) {
      id = (await trx.insertInto('events').values({ workspace_id: workspaceId, created_by: userId, ...values }).returning('id').executeTakeFirstOrThrow()).id;
    } else {
      const existing = await trx.selectFrom('events').select('series_id').where('id', '=', eventId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (existing === undefined) throw new NotFoundError('Événement');
      // Une occurrence d'une série n'est jamais elle-même récurrente.
      const set = existing.series_id === null ? values : { ...values, recurrence: 'none', recurrence_until: null };
      await trx.updateTable('events').set(set).where('id', '=', eventId).execute();
      id = eventId;
      await trx.deleteFrom('event_accounts').where('event_id', '=', id).execute();
      // EDI-08 : les occurrences à venir pas encore relayées sont recréées avec les nouveaux réglages.
      await trx
        .deleteFrom('events')
        .where('series_id', '=', id)
        .where('starts_on', '>', now.toISOString().slice(0, 10))
        .where((eb) => eb.not(eb.exists(eb.selectFrom('posts').select('posts.id').whereRef('posts.event_id', '=', 'events.id'))))
        .execute();
    }
    if (accountIds.length > 0) {
      await trx.insertInto('event_accounts').values(accountIds.map((accountId) => ({ event_id: id, account_id: accountId, workspace_id: workspaceId }))).execute();
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: eventId === null ? 'evenement.ajoute' : 'evenement.modifie', entity: 'event', entityId: id, details: { accounts: accountIds.length }, at: now });
    return id;
  });
}

export async function deleteEvent(db: Database, userId: string, workspaceId: string, eventId: string, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    await requireEditor(trx, userId, workspaceId);
    const row = await trx.deleteFrom('events').where('id', '=', eventId).where('workspace_id', '=', workspaceId).returning('title').executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Événement');
    await audit(trx, { workspaceId, actorUserId: userId, action: 'evenement.supprime', entity: 'event', entityId: eventId, details: { title: row.title }, at: now });
  });
}

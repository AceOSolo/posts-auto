/**
 * Données d'une rédaction (GEN-01 à GEN-03) : réglages de l'espace, ligne éditoriale,
 * comptes à alimenter, sujets pas encore traités, posts de la fenêtre, occupation des
 * créneaux. Lues en contexte système, toujours filtrées par l'espace.
 */
import type { BriefDocument } from '@posts-auto/ai';
import {
  type OccupiedSlot,
  type PostOrigin,
  SLOT_OCCUPYING_STATUSES,
  type SlotRules,
  type Subject,
  type WindowPost,
  type WorkspaceCalendar,
  addDays,
  startOfLocalDay,
} from '@posts-auto/core';
import { type Tx, calendarOf, slotRulesOf, weekStartOf } from '@posts-auto/db';
import {
  type AccountProfile,
  type EditorialLine,
  type OfferItem,
  type ReferencePost,
  accountProfileForSystem,
  currentEditorialLine,
  offerItems,
  referencePostsOf,
} from '@posts-auto/services';
import { sql } from 'kysely';

/** Comptes alimentés par la rédaction : connectés, ou à reconnecter (RÈG-22). Ni en pause (bascule, RÈG-21) ni retirés. */
export const ACTIVE_ACCOUNT_STATUSES = ['connected', 'expiring', 'expired'] as const;
/** RÈG-17 : une phrase n'apparaît jamais deux fois sur 8 semaines. */
export const REPEAT_WINDOW_DAYS = 56;

export interface WorkspaceSettings {
  readonly id: string;
  readonly name: string;
  readonly calendar: WorkspaceCalendar;
  readonly slotRules: SlotRules;
  readonly generationCron: string;
  readonly generationRequestedAt: Date | null;
}

export async function loadSettings(trx: Tx, workspaceId: string): Promise<WorkspaceSettings> {
  const row = await trx
    .selectFrom('workspaces')
    .select(['id', 'name', 'timezone', 'allowed_hours', 'holidays_calendar', 'slot_step_minutes', 'max_posts_per_account_per_day', 'min_gap_minutes', 'max_posts_per_slot', 'generation_cron', 'generation_requested_at'])
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    name: row.name,
    calendar: calendarOf(row),
    slotRules: slotRulesOf(row),
    generationCron: row.generation_cron,
    generationRequestedAt: row.generation_requested_at,
  };
}

export interface AccountData {
  readonly profile: AccountProfile;
  readonly holderUserId: string | null;
  readonly examples: readonly ReferencePost[];
  readonly learned: string;
  /** Posts récents du compte, du plus récent au plus ancien (contexte de l'IA, RÈG-17). */
  readonly recent: readonly { readonly date: string; readonly text: string }[];
}

/** Ce qu'il faut savoir d'un sujet pour le rédiger et relier le post à sa source (GEN-06, PLA-07). */
export interface SubjectInfo {
  readonly title: string;
  readonly documents: readonly BriefDocument[];
  readonly links: readonly string[];
  readonly source: { readonly planningCellId?: string; readonly subjectId?: string; readonly ideaId?: string; readonly eventId?: string };
}

export const subjectKey = (subject: Subject) => `${subject.kind}:${subject.id}`;

export interface GenerationData {
  readonly settings: WorkspaceSettings;
  readonly editorial: EditorialLine;
  readonly offer: readonly OfferItem[];
  readonly accounts: readonly AccountData[];
  readonly weeks: readonly string[];
  readonly subjects: readonly Subject[];
  readonly subjectInfo: ReadonlyMap<string, SubjectInfo>;
  readonly windowPosts: readonly WindowPost[];
  readonly occupied: readonly OccupiedSlot[];
  /** Textes des posts de l'espace sur 8 semaines (RÈG-17). */
  readonly otherPosts: readonly { readonly postId: string; readonly text: string }[];
  /** GEN-09 : articles récents des sources de veille, pas encore repris (du plus récent au plus ancien). */
  readonly articles: readonly Article[];
}

export interface Article {
  readonly id: string;
  readonly title: string;
  readonly link: string | null;
  readonly summary: string | null;
  readonly sourceLabel: string;
}

/** Fraîcheur maximale d'un article proposé à la rédaction. */
export const ARTICLE_MAX_AGE_DAYS = 30;

export async function loadArticles(trx: Tx, workspaceId: string, now: Date, limit = 10): Promise<Article[]> {
  const since = new Date(now.getTime() - ARTICLE_MAX_AGE_DAYS * 86_400_000);
  const rows = await trx
    .selectFrom('source_items as i')
    .innerJoin('content_sources as s', 's.id', 'i.source_id')
    .select(['i.id', 'i.title', 'i.link', 'i.summary', 's.label'])
    .where('i.workspace_id', '=', workspaceId)
    .where('s.enabled', '=', true)
    .where('i.used_post_id', 'is', null)
    .where(sql<boolean>`coalesce(i.published_at, i.fetched_at) >= ${since}`)
    .orderBy(sql`coalesce(i.published_at, i.fetched_at)`, 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ id: r.id, title: r.title, link: r.link, summary: r.summary, sourceLabel: r.label }));
}

/** Un sujet est traité s'il a donné un post encore en vie, ou remplacé par une reprise (GEN-03, décision 0005). */
function handled(column: 'planning_cell_id' | 'subject_id' | 'idea_id', outer: string) {
  return sql<boolean>`exists (
    select 1 from posts p
    where p.${sql.ref(column)} = ${sql.ref(outer)}
      and (p.status <> 'remplace' or exists (select 1 from posts s where s.replaces_post_id = p.id))
  )`;
}

export async function loadAccounts(trx: Tx, workspaceId: string, now: Date, accountIds?: readonly string[]): Promise<AccountData[]> {
  let query = trx
    .selectFrom('social_accounts')
    .select(['id', 'holder_user_id'])
    .where('workspace_id', '=', workspaceId)
    .where('status', 'in', [...ACTIVE_ACCOUNT_STATUSES])
    .orderBy('kind', 'desc')
    .orderBy('display_name');
  if (accountIds !== undefined) query = query.where('id', 'in', accountIds.length > 0 ? [...accountIds] : ['00000000-0000-0000-0000-000000000000']);
  const rows = await query.execute();
  const since = new Date(now.getTime() - REPEAT_WINDOW_DAYS * 86_400_000);
  const accounts: AccountData[] = [];
  for (const row of rows) {
    const profile = await accountProfileForSystem(trx, row.id);
    if (profile === null) continue;
    const learned = await trx.selectFrom('learned_preferences').select('summary').where('account_id', '=', row.id).executeTakeFirst();
    const recent = await trx
      .selectFrom('posts as p')
      .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.scheduled_at', 'v.body'])
      .where('p.account_id', '=', row.id)
      .where('p.status', 'in', ['publie', 'valide', 'en_publication', 'a_valider'])
      .where('p.scheduled_at', '>=', since)
      .orderBy('p.scheduled_at', 'desc')
      .limit(8)
      .execute();
    accounts.push({
      profile,
      holderUserId: row.holder_user_id,
      examples: await referencePostsOf(trx, row.id),
      learned: learned?.summary ?? '',
      recent: recent.map((r) => ({ date: r.scheduled_at.toISOString().slice(0, 10), text: r.body })),
    });
  }
  return accounts;
}

/** Textes des posts de l'espace sur 8 semaines, pour ne jamais répéter une phrase (RÈG-17). */
export async function loadOtherPosts(trx: Tx, workspaceId: string, now: Date): Promise<{ postId: string; text: string }[]> {
  const since = new Date(now.getTime() - REPEAT_WINDOW_DAYS * 86_400_000);
  const rows = await trx
    .selectFrom('posts as p')
    .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
    .select(['p.id', 'v.body'])
    .where('p.workspace_id', '=', workspaceId)
    .where('p.status', 'not in', ['remplace'])
    .where('p.scheduled_at', '>=', since)
    .execute();
  return rows.map((r) => ({ postId: r.id, text: r.body }));
}

/** Créneaux occupés de l'espace autour d'une période (RÈG-03, PUB-06). */
export async function loadOccupied(trx: Tx, workspaceId: string, from: Date, until: Date): Promise<OccupiedSlot[]> {
  const rows = await trx
    .selectFrom('posts')
    .select(['id', 'account_id', 'scheduled_at'])
    .where('workspace_id', '=', workspaceId)
    .where('status', 'in', [...SLOT_OCCUPYING_STATUSES])
    .where('scheduled_at', '>=', new Date(from.getTime() - 86_400_000))
    .where('scheduled_at', '<', new Date(until.getTime() + 86_400_000))
    .execute();
  return rows.map((r) => ({ postId: r.id, accountId: r.account_id, at: r.scheduled_at }));
}

export async function loadGenerationData(trx: Tx, workspaceId: string, now: Date): Promise<GenerationData> {
  const settings = await loadSettings(trx, workspaceId);
  const { calendar } = settings;
  const current = weekStartOf(now, calendar);
  const weeks = [current, addDays(current, 7)];
  const today = new Date(now.getTime()).toISOString().slice(0, 10);
  const windowEnd = addDays(current, 14);
  const accounts = await loadAccounts(trx, workspaceId, now);
  const activeIds = accounts.map((a) => a.profile.accountId);
  const ids = activeIds.length > 0 ? activeIds : ['00000000-0000-0000-0000-000000000000'];
  const subjects: Subject[] = [];
  const info = new Map<string, SubjectInfo>();

  // 1. Cases du planning de la fenêtre, ni mises de côté ni traitées.
  const cells = await trx
    .selectFrom('planning_cells as c')
    .leftJoin('subject_bank as b', 'b.id', 'c.subject_id')
    .select(['c.id', 'c.account_id', 'c.week_start', 'c.content', 'c.created_at', 'c.subject_id', 'b.theme', 'b.angle', 'b.format', 'b.offer', 'b.audience'])
    .where('c.workspace_id', '=', workspaceId)
    .where('c.row_kind', '=', 'account')
    .where('c.week_start', 'in', weeks)
    .where('c.set_aside_at', 'is', null)
    .where((eb) => eb.not(handled('planning_cell_id', 'c.id')))
    .orderBy('c.week_start')
    .orderBy('c.position')
    .execute();
  for (const c of cells) {
    const subject: Subject = { kind: 'planning_cell', id: c.id, accountId: c.account_id as string, weekStart: c.week_start, content: c.content, createdAt: c.created_at };
    subjects.push(subject);
    const precisions = [c.theme && `Thème : ${c.theme}`, c.angle && `Angle : ${c.angle}`, c.format && `Format : ${c.format}`, c.offer && `Offre : ${c.offer}`, c.audience && `Cible : ${c.audience}`].filter(Boolean).join('\n');
    info.set(subjectKey(subject), {
      title: c.content,
      documents: [{ type: 'case', id: `case-${c.id.slice(0, 8)}`, content: precisions === '' ? c.content : `${c.content}\n${precisions}` }],
      links: [],
      source: { planningCellId: c.id, ...(c.subject_id && { subjectId: c.subject_id }) },
    });
  }

  // 2. Événements à venir dans les 3 semaines qui suivent la fenêtre, par compte qui ne l'a pas encore relayé.
  const events = await trx
    .selectFrom('events as e')
    .innerJoin('event_accounts as ea', 'ea.event_id', 'e.id')
    .select(['e.id', 'e.title', 'e.starts_on', 'e.ends_on', 'e.link', 'e.details', 'e.created_at', 'ea.account_id'])
    .where('e.workspace_id', '=', workspaceId)
    .where('e.starts_on', '>', today)
    .where('e.starts_on', '<=', addDays(windowEnd, 21))
    .where('ea.account_id', 'in', ids)
    .where(
      sql<boolean>`not exists (
        select 1 from posts p
        where p.event_id = e.id and p.account_id = ea.account_id
          and (p.status <> 'remplace' or exists (select 1 from posts s where s.replaces_post_id = p.id))
      )`,
    )
    .orderBy('e.starts_on')
    .execute();
  const byEvent = new Map<string, typeof events>();
  for (const e of events) byEvent.set(e.id, [...(byEvent.get(e.id) ?? []), e]);
  for (const [id, rows] of byEvent) {
    const e = rows[0] as (typeof events)[number];
    const subject: Subject = { kind: 'event', id, title: e.title, startsOn: e.starts_on, accountIds: rows.map((r) => r.account_id), createdAt: e.created_at };
    subjects.push(subject);
    const dates = e.ends_on && e.ends_on !== e.starts_on ? `du ${e.starts_on} au ${e.ends_on}` : `le ${e.starts_on}`;
    info.set(subjectKey(subject), {
      title: e.title,
      documents: [{ type: 'evenement', id: `evenement-${id.slice(0, 8)}`, title: e.title, link: e.link, content: `${e.title}, ${dates}.${e.details ? `\n${e.details}` : ''}` }],
      links: e.link ? [e.link] : [],
      source: { eventId: id },
    });
  }

  // 3 et 5. Idées de l'équipe et réserve : nouvelles ou retenues, encore d'actualité.
  const ideas = await trx
    .selectFrom('ideas as i')
    .select(['i.id', 'i.title', 'i.details', 'i.link', 'i.origin', 'i.all_accounts', 'i.starts_on', 'i.ends_on', 'i.event_on', 'i.target_week', 'i.created_at'])
    .where('i.workspace_id', '=', workspaceId)
    .where('i.status', 'in', ['new', 'kept'])
    .where((eb) => eb.or([eb('i.ends_on', 'is', null), eb('i.ends_on', '>=', today)]))
    .where((eb) => eb.or([eb('i.event_on', 'is', null), eb('i.event_on', '>', today)]))
    .where((eb) => eb.not(handled('idea_id', 'i.id')))
    .orderBy(sql`i.target_week nulls last`)
    .orderBy('i.created_at')
    .execute();
  const ideaAccounts = ideas.length === 0 ? [] : await trx.selectFrom('idea_accounts').select(['idea_id', 'account_id']).where('idea_id', 'in', ideas.map((i) => i.id)).execute();
  for (const i of ideas) {
    const subject: Subject = {
      kind: 'idea',
      id: i.id,
      title: i.title,
      origin: i.origin as 'team' | 'ai_reserve',
      accountIds: i.all_accounts ? 'all' : ideaAccounts.filter((a) => a.idea_id === i.id).map((a) => a.account_id),
      startsOn: i.starts_on,
      endsOn: i.ends_on,
      eventOn: i.event_on,
      targetWeek: i.target_week,
      createdAt: i.created_at,
    };
    subjects.push(subject);
    info.set(subjectKey(subject), {
      title: i.title,
      documents: [{ type: i.origin === 'team' ? 'idee' : 'reserve', id: `idee-${i.id.slice(0, 8)}`, title: i.title, link: i.link, content: [i.title, i.details, i.event_on && `Événement le ${i.event_on}.`].filter(Boolean).join('\n') }],
      links: i.link ? [i.link] : [],
      source: { ideaId: i.id },
    });
  }

  // 4. Banque de sujets : non publiés, non traités, du compte ou commune.
  const bank = await trx
    .selectFrom('subject_bank as b')
    .select(['b.id', 'b.account_id', 'b.subject', 'b.theme', 'b.angle', 'b.format', 'b.offer', 'b.audience', 'b.created_at'])
    .where('b.workspace_id', '=', workspaceId)
    .where('b.published', '=', false)
    .where((eb) => eb.or([eb('b.account_id', 'is', null), eb('b.account_id', 'in', ids)]))
    .where((eb) => eb.not(handled('subject_id', 'b.id')))
    .orderBy('b.position')
    .orderBy('b.created_at')
    .execute();
  for (const b of bank) {
    const subject: Subject = { kind: 'bank', id: b.id, accountId: b.account_id, subject: b.subject, createdAt: b.created_at };
    subjects.push(subject);
    const precisions = [b.theme && `Thème : ${b.theme}`, b.angle && `Angle : ${b.angle}`, b.format && `Format : ${b.format}`, b.offer && `Offre : ${b.offer}`, b.audience && `Cible : ${b.audience}`].filter(Boolean).join('\n');
    info.set(subjectKey(subject), {
      title: b.subject,
      documents: [{ type: 'banque', id: `banque-${b.id.slice(0, 8)}`, content: precisions === '' ? b.subject : `${b.subject}\n${precisions}` }],
      links: [],
      source: { subjectId: b.id },
    });
  }

  const windowRows = await trx
    .selectFrom('posts as p')
    .select((eb) => [
      'p.id',
      'p.account_id',
      'p.week_start',
      'p.scheduled_at',
      'p.status',
      'p.origin',
      'p.planning_cell_id',
      'p.subject_id',
      'p.is_optional',
      'p.created_at',
      eb.exists(eb.selectFrom('post_versions as v').select('v.id').whereRef('v.post_id', '=', 'p.id').where('v.author_kind', '=', 'user')).as('edited'),
    ])
    .where('p.workspace_id', '=', workspaceId)
    .where('p.account_id', 'in', ids)
    .where('p.week_start', 'in', weeks)
    .execute();
  const windowPosts: WindowPost[] = windowRows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    weekStart: r.week_start,
    scheduledAt: r.scheduled_at,
    status: r.status,
    origin: r.origin as PostOrigin,
    planningCellId: r.planning_cell_id,
    subjectId: r.subject_id,
    isOptional: r.is_optional,
    createdAt: r.created_at,
    editedByHuman: Boolean(r.edited),
  }));

  return {
    settings,
    editorial: await currentEditorialLine(trx, workspaceId),
    offer: await offerItems(trx, workspaceId),
    accounts,
    weeks,
    subjects,
    subjectInfo: info,
    windowPosts,
    occupied: await loadOccupied(trx, workspaceId, now, startOfLocalDay(windowEnd, calendar)),
    otherPosts: await loadOtherPosts(trx, workspaceId, now),
    articles: await loadArticles(trx, workspaceId, now),
  };
}

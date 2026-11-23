/**
 * PLA-10 : journées nationales et mondiales suggérées selon le secteur, à ajouter en un clic.
 *
 * Une journée ajoutée devient un événement annuel (EDI-08), relayé par les pages de l'espace,
 * ou par tous ses comptes actifs s'il n'a pas de page. Les comptes restent modifiables ensuite.
 */
import { WORLD_DAYS, type WorldDaySuggestion, nextWorldDayDate, normalizeLabel, upcomingWorldDays } from '@posts-auto/core';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

/** Comptes que la rédaction traite : ni en pause, ni révoqués. */
const RELAYING_STATUSES = ['connected', 'expiring', 'expired'] as const;

const localDate = (now: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

async function workspaceContext(trx: Tx, workspaceId: string, now: Date): Promise<{ sector: string | null; today: string; planned: Set<string> }> {
  const workspace = await trx.selectFrom('workspaces').select(['sector', 'timezone']).where('id', '=', workspaceId).executeTakeFirst();
  if (workspace === undefined) throw new NotFoundError('Espace');
  const today = localDate(now, workspace.timezone);
  // Une occurrence (series_id) porte le même titre que son modèle : seul le modèle compte.
  const events = await trx
    .selectFrom('events')
    .select('title')
    .where('workspace_id', '=', workspaceId)
    .where('series_id', 'is', null)
    .where((eb) => eb.or([eb('recurrence', '<>', 'none'), eb(eb.fn.coalesce('ends_on', 'starts_on'), '>=', today)]))
    .execute();
  return { sector: workspace.sector, today, planned: new Set(events.map((e) => normalizeLabel(e.title))) };
}

export async function worldDaySuggestions(db: Database, userId: string, workspaceId: string, now: Date): Promise<{ suggestions: WorldDaySuggestion[]; canEdit: boolean }> {
  return asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    const { sector, today, planned } = await workspaceContext(trx, workspaceId, now);
    return { suggestions: upcomingWorldDays(sector, today, { excludeTitles: planned }), canEdit: canManageContent(role) };
  });
}

export async function addWorldDay(db: Database, userId: string, workspaceId: string, dayId: string, now: Date): Promise<string> {
  const day = WORLD_DAYS.find((d) => d.id === dayId);
  if (day === undefined) throw new NotFoundError('Journée');
  return asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    if (!canManageContent(role)) throw new ForbiddenError('editPlanning');
    // Un double clic n'ajoute pas la journée deux fois.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:journee:${day.id}`}, 0))`.execute(trx);
    const { today, planned } = await workspaceContext(trx, workspaceId, now);
    if (planned.has(normalizeLabel(day.title))) throw new RefusedError('journee_deja_ajoutee', 'Cette journée est déjà dans vos événements.');

    const accounts = await trx.selectFrom('social_accounts').select(['id', 'kind']).where('workspace_id', '=', workspaceId).where('status', 'in', [...RELAYING_STATUSES]).execute();
    const pages = accounts.filter((a) => a.kind === 'page');
    const relaying = pages.length > 0 ? pages : accounts;

    const event = await trx
      .insertInto('events')
      .values({
        workspace_id: workspaceId,
        created_by: userId,
        title: day.title,
        starts_on: nextWorldDayDate(day, today),
        link: day.source,
        // Le thème change chaque année : la rédaction ne doit pas l'inventer.
        details: `Journée ${day.scope} portée par ${day.organizer}, à date fixe chaque année. Ne citer le thème de l’année ou un chiffre qu’après vérification sur le lien officiel.`,
        recurrence: 'yearly',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (relaying.length > 0) {
      await trx
        .insertInto('event_accounts')
        .values(relaying.map((a) => ({ event_id: event.id, account_id: a.id, workspace_id: workspaceId })))
        .execute();
    }
    await audit(trx, { workspaceId, actorUserId: userId, action: 'evenement.journee_ajoutee', entity: 'event', entityId: event.id, details: { dayId: day.id, accounts: relaying.length }, at: now });
    return event.id;
  });
}

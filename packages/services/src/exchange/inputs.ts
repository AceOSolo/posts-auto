/**
 * Reprise des idées et des demandes de l'outil actuel (incrément 1b), par l'API d'échange.
 *
 * Idempotent comme le dépôt de posts (REC-13) : une même référence ne crée jamais de
 * doublon, ce qui permet de relancer la reprise sans risque.
 * Une demande reprise avec le statut « traitée » est gardée pour l'historique ; une demande
 * « nouvelle » sera rédigée par la tâche « demandes » (IDE-06) : à n'envoyer qu'une fois la
 * rédaction de l'ancien outil arrêtée.
 */
import { type Database, type Tx, asSystem } from '@posts-auto/db';
import { cleanLines, cleanText } from '../audit.ts';
import { ForbiddenError, RefusedError } from '../errors.ts';
import { type ApiKeyContext, lockReference } from './api-keys.ts';

const REFERENCE = /^[\w.:-]{1,100}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireInputs(ctx: ApiKeyContext): void {
  if (!ctx.scopes.has('inputs:write')) throw new ForbiddenError('inputs:write');
}

function date(value: string | undefined, field: string): string | null {
  if (value === undefined || value === '') return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (!ISO_DATE.test(value) || Number.isNaN(d.getTime()) || !d.toISOString().startsWith(value)) {
    throw new RefusedError('date_invalide', `${field} : date AAAA-MM-JJ attendue.`);
  }
  return value;
}

async function requireAccounts(trx: Tx, workspaceId: string, accountIds: readonly string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const found = await trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', workspaceId).where('id', 'in', [...accountIds]).execute();
  if (found.length !== new Set(accountIds).size) throw new RefusedError('unknown_account', 'Compte inconnu dans cet espace.');
}

export const IMPORTED_IDEA_STATUSES = { nouvelle: 'new', retenue: 'kept', utilisee: 'used', ecartee: 'dismissed' } as const;

export interface ImportedIdea {
  readonly reference: string;
  readonly title: string;
  readonly details?: string;
  readonly link?: string;
  readonly startsOn?: string;
  readonly endsOn?: string;
  readonly eventOn?: string;
  /** Vide : tous les comptes. */
  readonly accountIds?: readonly string[];
  readonly status?: keyof typeof IMPORTED_IDEA_STATUSES;
  readonly followup?: string;
  readonly createdAt?: Date;
}

export async function importIdea(db: Database, ctx: ApiKeyContext, input: ImportedIdea): Promise<{ created: boolean; id: string }> {
  requireInputs(ctx);
  if (!REFERENCE.test(input.reference)) throw new RefusedError('invalid_reference', 'Référence invalide (1 à 100 caractères : lettres, chiffres, _ . : -).');
  const title = cleanText(input.title, 300);
  if (title === null) throw new RefusedError('titre_requis', 'titre : obligatoire.');
  const status = input.status === undefined ? 'new' : IMPORTED_IDEA_STATUSES[input.status];
  if (status === undefined) throw new RefusedError('statut_invalide', `statut : ${Object.keys(IMPORTED_IDEA_STATUSES).join(', ')}.`);
  const accountIds = [...new Set(input.accountIds ?? [])];
  const values = {
    title,
    details: cleanText(input.details, 4000),
    link: cleanText(input.link, 1000),
    starts_on: date(input.startsOn, 'debut'),
    ends_on: date(input.endsOn, 'fin'),
    event_on: date(input.eventOn, 'evenement'),
    all_accounts: accountIds.length === 0,
    status,
    followup: cleanText(input.followup, 2000),
  };
  return asSystem(db, async (trx) => {
    await lockReference(trx, ctx.workspaceId, 'idee', input.reference);
    const existing = await trx.selectFrom('ideas').select('id').where('workspace_id', '=', ctx.workspaceId).where('external_ref', '=', input.reference).executeTakeFirst();
    if (existing !== undefined) return { created: false, id: existing.id };
    await requireAccounts(trx, ctx.workspaceId, accountIds);
    const row = await trx
      .insertInto('ideas')
      .values({ workspace_id: ctx.workspaceId, origin: 'team', external_ref: input.reference, ...values, ...(input.createdAt && { created_at: input.createdAt }) })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (accountIds.length > 0) await trx.insertInto('idea_accounts').values(accountIds.map((accountId) => ({ idea_id: row.id, account_id: accountId, workspace_id: ctx.workspaceId }))).execute();
    await trx
      .insertInto('audit_log')
      .values({ org_id: ctx.orgId, workspace_id: ctx.workspaceId, actor_kind: 'api_key', action: 'idee.reprise', entity: 'idea', entity_id: row.id, details: JSON.stringify({ keyId: ctx.keyId, reference: input.reference }) })
      .execute();
    return { created: true, id: row.id };
  });
}

export const IMPORTED_REQUEST_STATUSES = { nouvelle: 'new', traitee: 'done', impossible: 'impossible' } as const;

export interface ImportedRequest {
  readonly reference: string;
  readonly text: string;
  readonly accountIds: readonly string[];
  readonly wishedAt?: Date;
  readonly links?: readonly string[];
  /** Adresse d'un membre de l'espace ; sinon `requesterName`. */
  readonly requesterEmail?: string;
  readonly requesterName?: string;
  readonly status?: keyof typeof IMPORTED_REQUEST_STATUSES;
  readonly followup?: string;
  readonly createdAt?: Date;
}

export async function importPostRequest(db: Database, ctx: ApiKeyContext, input: ImportedRequest, now: Date): Promise<{ created: boolean; id: string }> {
  requireInputs(ctx);
  if (!REFERENCE.test(input.reference)) throw new RefusedError('invalid_reference', 'Référence invalide (1 à 100 caractères : lettres, chiffres, _ . : -).');
  const text = cleanText(input.text, 5000);
  if (text === null) throw new RefusedError('demande_vide', 'texte : obligatoire.');
  const accountIds = [...new Set(input.accountIds)];
  if (accountIds.length === 0) throw new RefusedError('compte_requis', 'comptes : au moins un compte.');
  const status = input.status === undefined ? 'new' : IMPORTED_REQUEST_STATUSES[input.status];
  if (status === undefined) throw new RefusedError('statut_invalide', `statut : ${Object.keys(IMPORTED_REQUEST_STATUSES).join(', ')}.`);
  return asSystem(db, async (trx) => {
    await lockReference(trx, ctx.workspaceId, 'demande', input.reference);
    const existing = await trx.selectFrom('post_requests').select('id').where('workspace_id', '=', ctx.workspaceId).where('external_ref', '=', input.reference).executeTakeFirst();
    if (existing !== undefined) return { created: false, id: existing.id };
    await requireAccounts(trx, ctx.workspaceId, accountIds);
    let createdBy: string | null = null;
    if (input.requesterEmail !== undefined) {
      const member = await trx
        .selectFrom('users as u')
        .innerJoin('workspace_members as m', 'm.user_id', 'u.id')
        .select('u.id')
        .where('m.workspace_id', '=', ctx.workspaceId)
        .where('u.email', '=', input.requesterEmail.trim().toLowerCase())
        .executeTakeFirst();
      createdBy = member?.id ?? null;
    }
    const label = cleanText(input.requesterName ?? input.requesterEmail, 200);
    if (createdBy === null && label === null) throw new RefusedError('demandeur_requis', 'demandeur_email ou demandeur_nom : obligatoire.');
    const row = await trx
      .insertInto('post_requests')
      .values({
        workspace_id: ctx.workspaceId,
        external_ref: input.reference,
        raw_text: text,
        links: cleanLines(input.links ?? [], 10, 1000).filter((l) => /^https?:\/\//i.test(l)),
        wished_at: input.wishedAt ?? null,
        status,
        followup: cleanText(input.followup, 2000),
        created_by: createdBy,
        requester_label: createdBy === null ? label : null,
        processed_at: status === 'new' ? null : now,
        ...(input.createdAt && { created_at: input.createdAt }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('request_accounts').values(accountIds.map((accountId) => ({ request_id: row.id, account_id: accountId, workspace_id: ctx.workspaceId }))).execute();
    await trx
      .insertInto('audit_log')
      .values({ org_id: ctx.orgId, workspace_id: ctx.workspaceId, actor_kind: 'api_key', action: 'demande.reprise', entity: 'post_request', entity_id: row.id, details: JSON.stringify({ keyId: ctx.keyId, reference: input.reference }) })
      .execute();
    return { created: true, id: row.id };
  });
}

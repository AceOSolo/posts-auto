/**
 * Essai gratuit (ONB-06) : 14 jours, sans carte bancaire, au plus 3 comptes LinkedIn et 10
 * posts rédigés par l'IA ; la publication réelle est autorisée.
 *
 * Une organisation est en essai tant qu'elle a une date de fin d'essai et pas encore
 * d'abonnement en cours (billing/subscriptions.ts). Les organisations créées à la main
 * (Secutop) n'ont pas de date de fin d'essai : aucune limite.
 *
 * - Un 4e compte, ou tout nouveau compte après la fin de l'essai, est refusé.
 * - La rédaction s'arrête à 10 posts (premières rédactions comptées dans le quota, RÈG-19 ;
 *   les reprises et les retouches ne comptent pas) et à la fin de l'essai.
 * - Les posts déjà validés partent toujours : couper la publication relève des impayés
 *   (FAC-06), pas de l'essai.
 */
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { canManageContent, workspaceRole } from '../access.ts';

export const TRIAL_MAX_ACCOUNTS = 3;
export const TRIAL_MAX_POSTS = 10;

export interface TrialState {
  readonly orgId: string;
  readonly onTrial: boolean;
  readonly endsAt: Date | null;
  readonly expired: boolean;
  /** Jours restants, arrondis au jour supérieur (0 si terminé). */
  readonly daysLeft: number;
  readonly accounts: number;
  readonly posts: number;
}

export async function trialStateForOrg(trx: Tx, orgId: string, now: Date): Promise<TrialState> {
  const org = await trx.selectFrom('organizations').select(['trial_ends_at']).where('id', '=', orgId).executeTakeFirstOrThrow();
  // En essai tant qu'aucun abonnement n'a pris le relais (un client Stripe seul ne suffit pas :
  // le paiement a pu être abandonné).
  const subscribed = await trx.selectFrom('subscriptions').select('status').where('org_id', '=', orgId).where('status', 'in', ['active', 'past_due', 'unpaid']).executeTakeFirst();
  const onTrial = org.trial_ends_at !== null && subscribed === undefined;
  const accounts = await trx
    .selectFrom('social_accounts as a')
    .innerJoin('workspaces as w', 'w.id', 'a.workspace_id')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('w.org_id', '=', orgId)
    .where('a.status', '<>', 'revoked')
    .executeTakeFirstOrThrow();
  const posts = await trx
    .selectFrom('ai_usage as u')
    .innerJoin('workspaces as w', 'w.id', 'u.workspace_id')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('w.org_id', '=', orgId)
    .where('u.kind', '=', 'text')
    .where('u.counted_in_quota', '=', true)
    .executeTakeFirstOrThrow();
  const endsAt = org.trial_ends_at;
  const expired = onTrial && endsAt !== null && now.getTime() >= endsAt.getTime();
  return {
    orgId,
    onTrial,
    endsAt,
    expired,
    daysLeft: onTrial && endsAt !== null && !expired ? Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000) : 0,
    accounts: accounts.n,
    posts: posts.n,
  };
}

export async function trialStateForWorkspace(trx: Tx, workspaceId: string, now: Date): Promise<TrialState> {
  const workspace = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
  return trialStateForOrg(trx, workspace.org_id, now);
}

/** Posts que l'IA peut encore rédiger ; null : pas de limite (organisation hors essai). */
export function remainingTrialPosts(state: TrialState): number | null {
  if (!state.onTrial) return null;
  if (state.expired) return 0;
  return Math.max(0, TRIAL_MAX_POSTS - state.posts);
}

/** Raison d'un refus de rédaction pendant l'essai, pour les rapports et le suivi des demandes. */
export function trialLimitReason(state: TrialState): string {
  return state.expired
    ? 'Essai gratuit terminé : la rédaction reprendra avec l’abonnement.'
    : `Limite de l’essai gratuit atteinte (${TRIAL_MAX_POSTS} posts rédigés) : la rédaction reprendra avec l’abonnement.`;
}

/** Bandeau d'essai : organisations en essai dont la personne gère au moins un espace. */
export async function trialBanners(
  db: Database,
  userId: string,
  now: Date,
): Promise<(TrialState & { readonly orgName: string; readonly workspaceId: string; readonly canSubscribe: boolean })[]> {
  const orgs = await asUser(db, userId, async (trx) => {
    const workspaces = await trx.selectFrom('workspaces').select(['id', 'org_id']).orderBy('created_at').execute();
    // Organisation -> premier espace géré (lien vers la page d'abonnement) et rôle propriétaire.
    const managed = new Map<string, { workspaceId: string; owner: boolean }>();
    for (const w of workspaces) {
      const role = await workspaceRole(trx, userId, w.id);
      if (canManageContent(role) && !managed.has(w.org_id)) managed.set(w.org_id, { workspaceId: w.id, owner: role === 'owner' });
    }
    return [...managed];
  });
  if (orgs.length === 0) return [];
  // L'appartenance est vérifiée ci-dessus ; les compteurs portent sur toute l'organisation.
  return asSystem(db, async (trx) => {
    const result: (TrialState & { orgName: string; workspaceId: string; canSubscribe: boolean })[] = [];
    for (const [orgId, { workspaceId, owner }] of orgs) {
      const state = await trialStateForOrg(trx, orgId, now);
      if (!state.onTrial) continue;
      const org = await trx.selectFrom('organizations').select('name').where('id', '=', orgId).executeTakeFirstOrThrow();
      result.push({ ...state, orgName: org.name, workspaceId, canSubscribe: owner });
    }
    return result;
  });
}

/** Un nouveau compte LinkedIn peut-il être connecté ? */
export function canConnectAccount(state: TrialState): { readonly ok: true } | { readonly ok: false; readonly code: 'essai_comptes' | 'essai_termine' } {
  if (!state.onTrial) return { ok: true };
  if (state.expired) return { ok: false, code: 'essai_termine' };
  return state.accounts < TRIAL_MAX_ACCOUNTS ? { ok: true } : { ok: false, code: 'essai_comptes' };
}

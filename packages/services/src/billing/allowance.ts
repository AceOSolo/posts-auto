/**
 * Droit à rédiger et à publier d'un espace (ONB-06, FAC-04, FAC-06, RÈG-19, RÈG-20) :
 *
 * - pilote : organisation créée à la main, sans essai ni abonnement (Secutop) : aucune limite ;
 * - essai : 10 posts et 3 comptes pour toute l'organisation, 14 jours (billing/trial.ts) ;
 * - essai terminé sans abonnement : plus de rédaction, la publication continue ;
 * - abonné : quota de la formule par compte actif, mutualisé dans l'espace [C6], plus les
 *   packs achetés, sur la période de facturation en cours (RÈG-20 : date anniversaire) ;
 * - impayé depuis 14 jours ou plus (FAC-06) : ni rédaction ni publication ; les données
 *   sont conservées.
 *
 * Seules les premières rédactions comptent (RÈG-19) ; chaque image générée compte.
 */
import type { Tx } from '@posts-auto/db';
import { sql } from 'kysely';
import { isOrgSuspended } from '../admin/suspension.ts';
import { TRIAL_MAX_POSTS, trialStateForOrg } from './trial.ts';

/** FAC-06 : suspension à J+14 d'un impayé. */
export const UNPAID_SUSPENSION_DAYS = 14;

/** `editor_suspended` : suspension décidée par l'éditeur, indépendante du paiement. */
export type BillingMode = 'pilot' | 'trial' | 'trial_over' | 'subscribed' | 'suspended' | 'editor_suspended';

export interface Quota {
  readonly used: number;
  /** null : pas de plafond. */
  readonly limit: number | null;
  readonly remaining: number | null;
}

export interface Allowance {
  readonly orgId: string;
  readonly mode: BillingMode;
  readonly planKey: string | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly posts: Quota;
  readonly images: Quota;
  readonly canPublish: boolean;
  readonly overagePolicy: 'suspend' | 'packs';
  /** Pourquoi la rédaction s'arrête (rapports, suivi des demandes), quand elle s'arrête. */
  readonly reason: string | null;
  /** Ce qui sera dit quand le quota sera épuisé (rédaction en cours qui atteint le plafond). */
  readonly limitReason: string;
}

const quota = (used: number, limit: number | null): Quota => ({ used, limit, remaining: limit === null ? null : Math.max(0, limit - used) });
const UNLIMITED: Quota = { used: 0, limit: null, remaining: null };
const EDITOR_SUSPENDED = 'Service suspendu par l’éditeur : la rédaction et la publication sont arrêtées, vos données sont conservées. Contactez le support.';
const SUSPENDED = 'Abonnement impayé : la rédaction et la publication sont suspendues jusqu’au règlement. Les données sont conservées 90 jours.';
const CANCELED_UNPAID = 'Abonnement résilié pour impayé : la rédaction et la publication sont suspendues. Les données sont conservées 90 jours.';
const CANCELED = 'Abonnement résilié : la rédaction est arrêtée ; les posts déjà validés partent toujours.';
const TRIAL_OVER = 'Essai gratuit terminé : la rédaction reprendra avec l’abonnement.';
const TRIAL_LIMIT = `Limite de l’essai gratuit atteinte (${TRIAL_MAX_POSTS} posts rédigés) : la rédaction reprendra avec l’abonnement.`;
const QUOTA_PACKS = 'Quota de posts du mois atteint : achetez un pack pour continuer, ou attendez le mois de quota suivant.';
const QUOTA_SUSPEND = 'Quota de posts du mois atteint : la rédaction reprendra au début du mois de quota suivant.';

/** FAC-06 : l'abonnement est-il suspendu pour impayé à cette date ? */
export function isUnpaidSuspended(sub: { readonly status: string; readonly past_due_since: Date | null }, now: Date): boolean {
  if (sub.status === 'incomplete') return false;
  // Résilié pour impayé : la suspension continue jusqu'au règlement.
  if (sub.status === 'canceled') return sub.past_due_since !== null;
  if (sub.status === 'unpaid') return true;
  return sub.past_due_since !== null && (now.getTime() - sub.past_due_since.getTime()) / 86_400_000 >= UNPAID_SUSPENSION_DAYS;
}

/** FAC-06, côté action d'une personne : l'impayé interdit-il de publier ? */
export async function isPublicationBlockedByPayment(trx: Tx, orgId: string, now: Date): Promise<boolean> {
  const org = await trx.selectFrom('organizations').select('status').where('id', '=', orgId).executeTakeFirstOrThrow();
  if (org.status !== 'active' && org.status !== 'past_due') return true;
  const sub = await trx.selectFrom('subscriptions').select(['status', 'past_due_since']).where('org_id', '=', orgId).executeTakeFirst();
  return sub !== undefined && isUnpaidSuspended(sub, now);
}

/** FAC-06, côté tâches de fond : même règle que `isUnpaidSuspended`, dans la requête. */
export function workspaceNotBlockedByPayment(column: string, now: Date) {
  const limit = new Date(now.getTime() - UNPAID_SUSPENSION_DAYS * 86_400_000);
  return sql<boolean>`exists (
    select 1 from workspaces bw
    join organizations bo on bo.id = bw.org_id
    left join subscriptions bs on bs.org_id = bo.id
    where bw.id = ${sql.ref(column)}
      and bo.status in ('active', 'past_due')
      and (
        bs.org_id is null
        or bs.status = 'incomplete'
        or (bs.status = 'canceled' and bs.past_due_since is null)
        or (bs.status in ('active', 'past_due') and (bs.past_due_since is null or bs.past_due_since > ${limit}))
      )
  )`;
}

/** Comptes facturés : tous sauf ceux en pause (LNK-07) ou déconnectés. */
export const BILLABLE_ACCOUNT_STATUSES = ['connected', 'expiring', 'expired'] as const;

async function usage(trx: Tx, workspaceId: string, since: Date, kind: 'text' | 'image'): Promise<number> {
  const row = await trx
    .selectFrom('ai_usage')
    .select(kind === 'text' ? sql<number>`count(*)::int`.as('n') : sql<number>`coalesce(sum(units), 0)::int`.as('n'))
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', kind)
    .where('counted_in_quota', '=', true)
    .where('at', '>=', since)
    .executeTakeFirstOrThrow();
  return row.n;
}

/**
 * RÈG-20 : le quota est mensuel, remis à zéro à la date anniversaire, y compris pour un
 * abonnement annuel. Renvoie le mois de quota qui contient « now », borné à la période payée.
 */
export function quotaWindow(periodStart: Date, periodEnd: Date, now: Date): { start: Date; end: Date } {
  const monthsFrom = (months: number) => {
    const d = new Date(periodStart);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    // 31 janvier + 1 mois = 28 ou 29 février (dernier jour du mois), pas 3 mars.
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
  };
  let k = 0;
  while (k < 12 && monthsFrom(k + 1).getTime() <= now.getTime() && monthsFrom(k + 1).getTime() < periodEnd.getTime()) k += 1;
  const end = monthsFrom(k + 1);
  return { start: monthsFrom(k), end: end.getTime() > periodEnd.getTime() ? periodEnd : end };
}

export async function allowanceForWorkspace(trx: Tx, workspaceId: string, now: Date): Promise<Allowance> {
  const workspace = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
  const orgId = workspace.org_id;
  const sub = await trx.selectFrom('subscriptions').selectAll().where('org_id', '=', orgId).executeTakeFirst();
  const base = { orgId, planKey: sub?.plan_key ?? null, overagePolicy: (sub?.overage_policy ?? 'suspend') as 'suspend' | 'packs' };

  if (await isOrgSuspended(trx, orgId)) {
    return {
      ...base,
      mode: 'editor_suspended',
      periodStart: null,
      periodEnd: null,
      posts: quota(0, 0),
      images: quota(0, 0),
      canPublish: false,
      reason: EDITOR_SUSPENDED,
      limitReason: EDITOR_SUSPENDED,
    };
  }

  if (sub !== undefined && sub.status !== 'canceled' && sub.status !== 'incomplete') {
    const { start: periodStart, end: periodEnd } = quotaWindow(sub.current_period_start, sub.current_period_end, now);
    if (isUnpaidSuspended(sub, now)) {
      return {
        ...base,
        mode: 'suspended',
        periodStart,
        periodEnd,
        posts: quota(0, 0),
        images: quota(0, 0),
        canPublish: false,
        reason: SUSPENDED,
        limitReason: SUSPENDED,
      };
    }
    const plan = await trx.selectFrom('plans').select(['posts_per_account', 'images_per_account']).where('key', '=', sub.plan_key).executeTakeFirstOrThrow();
    const accounts = await trx
      .selectFrom('social_accounts')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('status', 'in', [...BILLABLE_ACCOUNT_STATUSES])
      .executeTakeFirstOrThrow();
    const packs = await trx
      .selectFrom('quota_packs')
      .select([sql<number>`coalesce(sum(posts), 0)::int`.as('posts'), sql<number>`coalesce(sum(images), 0)::int`.as('images')])
      .where('workspace_id', '=', workspaceId)
      .where('period_start', '=', periodStart)
      .executeTakeFirstOrThrow();
    const posts = quota(await usage(trx, workspaceId, periodStart, 'text'), plan.posts_per_account * accounts.n + packs.posts);
    const images = plan.images_per_account === null ? quota(await usage(trx, workspaceId, periodStart, 'image'), null) : quota(await usage(trx, workspaceId, periodStart, 'image'), plan.images_per_account * accounts.n + packs.images);
    const limitReason = base.overagePolicy === 'packs' ? QUOTA_PACKS : QUOTA_SUSPEND;
    return { ...base, mode: 'subscribed', periodStart, periodEnd, posts, images, canPublish: true, reason: posts.remaining === 0 ? limitReason : null, limitReason };
  }

  const canceled = sub !== undefined && sub.status === 'canceled';
  // Résilié pour impayé : la suspension continue jusqu'au règlement (FAC-06).
  if (canceled && sub.past_due_since !== null) {
    return {
      ...base,
      mode: 'suspended',
      periodStart: null,
      periodEnd: null,
      posts: quota(0, 0),
      images: quota(0, 0),
      canPublish: false,
      reason: CANCELED_UNPAID,
      limitReason: CANCELED_UNPAID,
    };
  }
  const trial = await trialStateForOrg(trx, orgId, now);
  // Un abonnement résilié ne redonne ni l'essai ni l'accès sans limite du pilote.
  if (trial.endsAt === null && !canceled) return { ...base, mode: 'pilot', periodStart: null, periodEnd: null, posts: UNLIMITED, images: UNLIMITED, canPublish: true, reason: null, limitReason: '' };
  // Fin d'essai lue sur la date : un paiement commencé mais pas abouti ne prolonge pas l'essai.
  if (canceled || trial.endsAt === null || now.getTime() >= trial.endsAt.getTime()) {
    const reason = canceled ? CANCELED : TRIAL_OVER;
    return {
      ...base,
      mode: 'trial_over',
      periodStart: null,
      periodEnd: trial.endsAt,
      posts: quota(trial.posts, 0),
      images: UNLIMITED,
      canPublish: true,
      reason,
      limitReason: reason,
    };
  }
  const posts = quota(trial.posts, TRIAL_MAX_POSTS);
  return {
    ...base,
    mode: 'trial',
    periodStart: null,
    periodEnd: trial.endsAt,
    posts,
    images: UNLIMITED,
    canPublish: true,
    reason: posts.remaining === 0 ? TRIAL_LIMIT : null,
    limitReason: TRIAL_LIMIT,
  };
}

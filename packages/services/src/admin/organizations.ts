/**
 * ADM-01 : liste des organisations (formule, comptes actifs, usage de l'IA, revenu mensuel,
 * état de paiement, dernière activité) et fiche d'une organisation.
 */
import { DEFAULT_WORKSPACE_CALENDAR, startOfLocalMonth } from '@posts-auto/core';
import { type Database, asSystem } from '@posts-auto/db';
import { sql } from 'kysely';
import { NotFoundError } from '../errors.ts';
import { requirePlatformAdmin } from './platform.ts';

export type PaymentState = 'pilote' | 'essai' | 'essai_termine' | 'a_jour' | 'impaye' | 'suspendu' | 'resilie' | 'paiement_non_abouti';

export interface OrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'entreprise' | 'agence';
  readonly createdAt: Date;
  readonly planName: string | null;
  readonly interval: 'month' | 'year' | null;
  readonly paymentState: PaymentState;
  readonly pastDueSince: Date | null;
  readonly workspaces: number;
  readonly activeAccounts: number;
  readonly postsThisMonth: number;
  readonly imagesThisMonth: number;
  readonly aiCostEurThisMonth: number;
  /** Revenu mensuel récurrent hors taxes, d'après les prix affichés ; null si inconnu. */
  readonly mrrCents: number | null;
  readonly lastActivityAt: Date | null;
}

function paymentState(row: { org_status: string; trial_ends_at: Date | null; sub_status: string | null }, now: Date): PaymentState {
  if (row.org_status === 'suspended') return 'suspendu';
  switch (row.sub_status) {
    case 'active':
      return 'a_jour';
    case 'past_due':
      return 'impaye';
    case 'unpaid':
      return 'suspendu';
    case 'canceled':
      return 'resilie';
    case 'incomplete':
      return 'paiement_non_abouti';
    default:
      if (row.trial_ends_at === null) return 'pilote';
      return now.getTime() < row.trial_ends_at.getTime() ? 'essai' : 'essai_termine';
  }
}

export async function listOrganizations(db: Database, adminId: string, now: Date, search = ''): Promise<OrganizationRow[]> {
  await requirePlatformAdmin(db, adminId);
  const monthStart = startOfLocalMonth(now, DEFAULT_WORKSPACE_CALENDAR);
  const term = search.trim().toLowerCase();
  return asSystem(db, async (trx) => {
    let query = trx
      .selectFrom('organizations as o')
      .leftJoin('subscriptions as s', 's.org_id', 'o.id')
      .leftJoin('plans as p', 'p.key', 's.plan_key')
      .select([
        'o.id',
        'o.name',
        'o.kind',
        'o.created_at',
        'o.status as org_status',
        'o.trial_ends_at',
        's.status as sub_status',
        's.billing_interval',
        's.quantity',
        's.past_due_since',
        'p.name as plan_name',
        'p.price_monthly_cents',
        'p.price_yearly_cents',
        sql<number>`(select count(*)::int from workspaces w where w.org_id = o.id)`.as('workspaces'),
        sql<number>`(select count(*)::int from social_accounts a join workspaces w on w.id = a.workspace_id where w.org_id = o.id and a.status in ('connected', 'expiring', 'expired'))`.as('accounts'),
        sql<number>`(select count(*)::int from ai_usage u join workspaces w on w.id = u.workspace_id where w.org_id = o.id and u.kind = 'text' and u.counted_in_quota and u.at >= ${monthStart})`.as('posts'),
        sql<number>`(select coalesce(sum(u.units), 0)::int from ai_usage u join workspaces w on w.id = u.workspace_id where w.org_id = o.id and u.kind = 'image' and u.at >= ${monthStart})`.as('images'),
        sql<number>`(select coalesce(sum(u.cost_eur), 0)::float8 from ai_usage u join workspaces w on w.id = u.workspace_id where w.org_id = o.id and u.at >= ${monthStart})`.as('cost'),
        sql<Date | null>`greatest(
          (select max(se.last_seen_at) from sessions se where se.support_admin_id is null and se.user_id in (
            select m.user_id from workspace_members m join workspaces w on w.id = m.workspace_id where w.org_id = o.id
            union select om.user_id from org_members om where om.org_id = o.id)),
          (select max(a.at) from audit_log a where a.org_id = o.id and a.actor_kind = 'user'))`.as('last_activity'),
      ])
      .orderBy('o.name');
    if (term !== '') query = query.where(sql`lower(o.name)`, 'like', `%${term.replace(/[%_\\]/g, '\\$&')}%`);
    const rows = await query.execute();
    return rows.map((r) => {
      const state = paymentState(r, now);
      const billed = state === 'a_jour' || state === 'impaye';
      const unit = r.billing_interval === 'year' ? (r.price_yearly_cents === null ? null : r.price_yearly_cents / 12) : r.price_monthly_cents;
      return {
        id: r.id,
        name: r.name,
        kind: r.kind as 'entreprise' | 'agence',
        createdAt: r.created_at,
        planName: r.plan_name,
        interval: (r.billing_interval as 'month' | 'year' | null) ?? null,
        paymentState: state,
        pastDueSince: r.past_due_since,
        workspaces: r.workspaces,
        activeAccounts: r.accounts,
        postsThisMonth: r.posts,
        imagesThisMonth: r.images,
        aiCostEurThisMonth: Math.round(r.cost * 100) / 100,
        mrrCents: billed && unit !== null && r.quantity !== null ? Math.round(unit * r.quantity) : billed ? null : 0,
        lastActivityAt: r.last_activity,
      };
    });
  });
}

export interface OrganizationDetail {
  readonly id: string;
  readonly name: string;
  readonly kind: 'entreprise' | 'agence';
  readonly status: string;
  readonly createdAt: Date;
  readonly trialEndsAt: Date | null;
  readonly stripeCustomerId: string | null;
  readonly subscription: { readonly planName: string; readonly status: string; readonly interval: string; readonly quantity: number; readonly periodEnd: Date; readonly cancelAtPeriodEnd: boolean } | null;
  readonly workspaces: readonly { readonly id: string; readonly name: string; readonly accounts: number; readonly published30d: number; readonly pending: number }[];
  readonly people: readonly { readonly email: string; readonly name: string | null; readonly roles: string; readonly lastLoginAt: Date | null; readonly mfa: boolean }[];
  readonly supportGrants: readonly { readonly id: string; readonly workspaceId: string; readonly workspaceName: string; readonly grantedBy: string; readonly reason: string | null; readonly expiresAt: Date }[];
}

export async function organizationDetail(db: Database, adminId: string, orgId: string, now: Date): Promise<OrganizationDetail> {
  await requirePlatformAdmin(db, adminId);
  return asSystem(db, async (trx) => {
    const org = await trx.selectFrom('organizations').selectAll().where('id', '=', orgId).executeTakeFirst();
    if (org === undefined) throw new NotFoundError('Organisation');
    const sub = await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.key', 's.plan_key').selectAll('s').select('p.name as plan_name').where('s.org_id', '=', orgId).executeTakeFirst();
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const workspaces = await trx
      .selectFrom('workspaces as w')
      .select([
        'w.id',
        'w.name',
        sql<number>`(select count(*)::int from social_accounts a where a.workspace_id = w.id and a.status in ('connected', 'expiring', 'expired'))`.as('accounts'),
        sql<number>`(select count(*)::int from posts p where p.workspace_id = w.id and p.status = 'publie' and p.published_at >= ${since})`.as('published'),
        sql<number>`(select count(*)::int from posts p where p.workspace_id = w.id and p.status = 'a_valider')`.as('pending'),
      ])
      .where('w.org_id', '=', orgId)
      .orderBy('w.name')
      .execute();
    const people = await trx
      .selectFrom('users as u')
      .select([
        'u.email',
        'u.full_name',
        'u.last_login_at',
        sql<string>`concat_ws(', ',
          (select 'propriétaire' from org_members om where om.org_id = ${orgId} and om.user_id = u.id and om.role = 'owner'),
          (select string_agg(w.name || ' : ' || m.role, ', ' order by w.name) from workspace_members m join workspaces w on w.id = m.workspace_id where w.org_id = ${orgId} and m.user_id = u.id))`.as('roles'),
        sql<boolean>`exists (select 1 from user_totp t where t.user_id = u.id and t.confirmed_at is not null)`.as('mfa'),
      ])
      .where((eb) =>
        eb.or([
          eb('u.id', 'in', eb.selectFrom('org_members').select('user_id').where('org_id', '=', orgId)),
          eb('u.id', 'in', eb.selectFrom('workspace_members as m').innerJoin('workspaces as w', 'w.id', 'm.workspace_id').select('m.user_id').where('w.org_id', '=', orgId)),
        ]),
      )
      .orderBy('u.email')
      .execute();
    const grants = await trx
      .selectFrom('support_grants as g')
      .innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
      .innerJoin('users as u', 'u.id', 'g.granted_by')
      .select(['g.id', 'g.workspace_id', 'w.name as workspace_name', 'u.email', 'g.reason', 'g.expires_at'])
      .where('w.org_id', '=', orgId)
      .where('g.revoked_at', 'is', null)
      .where('g.expires_at', '>', now)
      .orderBy('g.expires_at', 'desc')
      .execute();
    return {
      id: org.id,
      name: org.name,
      kind: org.kind as 'entreprise' | 'agence',
      status: org.status,
      createdAt: org.created_at,
      trialEndsAt: org.trial_ends_at,
      stripeCustomerId: org.stripe_customer_id,
      subscription:
        sub === undefined
          ? null
          : { planName: sub.plan_name, status: sub.status, interval: sub.billing_interval, quantity: sub.quantity, periodEnd: sub.current_period_end, cancelAtPeriodEnd: sub.cancel_at_period_end },
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, accounts: w.accounts, published30d: w.published, pending: w.pending })),
      people: people.map((p) => ({ email: p.email, name: p.full_name, roles: p.roles, lastLoginAt: p.last_login_at, mfa: p.mfa })),
      supportGrants: grants.map((g) => ({ id: g.id, workspaceId: g.workspace_id, workspaceName: g.workspace_name, grantedBy: g.email, reason: g.reason, expiresAt: g.expires_at })),
    };
  });
}

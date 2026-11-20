/**
 * Abonnement de l'organisation (FAC-01 à FAC-07).
 *
 * - Le propriétaire de l'organisation souscrit, change de formule ou résilie (portail Stripe).
 * - L'abonnement est le reflet de Stripe : il n'est écrit qu'à partir des événements reçus
 *   (applyBillingEvent), chacun traité une seule fois.
 * - Quantité facturée = comptes actifs de l'organisation (FAC-02), resynchronisée chaque
 *   jour : un ajout est facturé au prorata, un retrait compte à la période suivante.
 * - Impayé (FAC-06) : relances à J+3 et J+7, suspension à J+14 (billing/allowance.ts).
 */
import { type Database, type Tx, asSystem, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { workspaceRole } from '../access.ts';
import { audit } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { type Allowance, BILLABLE_ACCOUNT_STATUSES, UNPAID_SUSPENSION_DAYS, allowanceForWorkspace, quotaWindow } from './allowance.ts';
import type { BillingEvent, BillingProvider } from './stripe.ts';

export interface PlanOffer {
  readonly key: string;
  readonly name: string;
  readonly postsPerAccount: number;
  readonly imagesPerAccount: number | null;
  readonly maxWorkspaces: number | null;
  readonly features: readonly string[];
  readonly monthly: boolean;
  readonly yearly: boolean;
  /** Prix affichés, en centimes hors taxes par compte ; null : pas encore fixé. */
  readonly priceMonthlyCents: number | null;
  readonly priceYearlyCents: number | null;
}

export interface WorkspaceUsage {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly accounts: number;
  readonly allowance: Allowance;
}

export interface BillingOverview {
  readonly orgId: string;
  readonly orgName: string;
  readonly orgKind: 'entreprise' | 'agence';
  /** Seul le propriétaire gère l'abonnement. */
  readonly canManage: boolean;
  readonly trialEndsAt: Date | null;
  readonly subscription: {
    readonly planKey: string;
    readonly planName: string;
    readonly status: string;
    readonly interval: 'month' | 'year';
    readonly quantity: number;
    readonly periodEnd: Date;
    readonly cancelAtPeriodEnd: boolean;
    readonly overagePolicy: 'suspend' | 'packs';
    readonly pastDueSince: Date | null;
  } | null;
  readonly plans: readonly PlanOffer[];
  readonly packs: readonly { readonly key: string; readonly name: string; readonly available: boolean; readonly priceCents: number | null }[];
  readonly usage: readonly WorkspaceUsage[];
  readonly billableAccounts: number;
}

async function orgOf(trx: Tx, userId: string, workspaceId: string): Promise<{ orgId: string; owner: boolean }> {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow();
  return { orgId: ws.org_id, owner: role === 'owner' };
}

async function billableAccounts(trx: Tx, orgId: string): Promise<number> {
  const row = await trx
    .selectFrom('social_accounts as a')
    .innerJoin('workspaces as w', 'w.id', 'a.workspace_id')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('w.org_id', '=', orgId)
    .where('a.status', 'in', [...BILLABLE_ACCOUNT_STATUSES])
    .executeTakeFirstOrThrow();
  return row.n;
}

/** Page « Abonnement » : formule, usage par espace (FAC-04), formules proposées. */
export async function billingOverview(db: Database, userId: string, workspaceId: string, now: Date): Promise<BillingOverview> {
  const { orgId, owner } = await asUser(db, userId, (trx) => orgOf(trx, userId, workspaceId));
  // Membre vérifié ci-dessus ; les compteurs portent sur toute l'organisation.
  return asSystem(db, async (trx) => {
    const org = await trx.selectFrom('organizations').select(['name', 'kind', 'trial_ends_at']).where('id', '=', orgId).executeTakeFirstOrThrow();
    const sub = await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.key', 's.plan_key').selectAll('s').select('p.name as plan_name').where('s.org_id', '=', orgId).executeTakeFirst();
    const plans = await trx.selectFrom('plans').selectAll().where('active', '=', true).orderBy('position').execute();
    const packs = await trx.selectFrom('quota_pack_offers').selectAll().where('active', '=', true).orderBy('key').execute();
    const workspaces = await trx.selectFrom('workspaces').select(['id', 'name']).where('org_id', '=', orgId).orderBy('created_at').execute();
    const usage: WorkspaceUsage[] = [];
    for (const w of workspaces) {
      const accounts = await trx
        .selectFrom('social_accounts')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('workspace_id', '=', w.id)
        .where('status', 'in', [...BILLABLE_ACCOUNT_STATUSES])
        .executeTakeFirstOrThrow();
      usage.push({ workspaceId: w.id, workspaceName: w.name, accounts: accounts.n, allowance: await allowanceForWorkspace(trx, w.id, now) });
    }
    return {
      orgId,
      orgName: org.name,
      orgKind: org.kind as 'entreprise' | 'agence',
      canManage: owner,
      trialEndsAt: org.trial_ends_at,
      subscription:
        sub === undefined
          ? null
          : {
              planKey: sub.plan_key,
              planName: sub.plan_name,
              status: sub.status,
              interval: sub.billing_interval as 'month' | 'year',
              quantity: sub.quantity,
              periodEnd: sub.current_period_end,
              cancelAtPeriodEnd: sub.cancel_at_period_end,
              overagePolicy: sub.overage_policy as 'suspend' | 'packs',
              pastDueSince: sub.past_due_since,
            },
      plans: plans.map((p) => ({
        key: p.key,
        name: p.name,
        postsPerAccount: p.posts_per_account,
        imagesPerAccount: p.images_per_account,
        maxWorkspaces: p.max_workspaces,
        features: p.features,
        monthly: p.stripe_price_monthly !== null,
        yearly: p.stripe_price_yearly !== null,
        priceMonthlyCents: p.price_monthly_cents,
        priceYearlyCents: p.price_yearly_cents,
      })),
      packs: packs.map((p) => ({ key: p.key, name: p.name, available: p.stripe_price !== null, priceCents: p.price_cents })),
      usage,
      billableAccounts: await billableAccounts(trx, orgId),
    };
  });
}

async function requireOwner(db: Database, userId: string, workspaceId: string): Promise<string> {
  const { orgId, owner } = await asUser(db, userId, (trx) => orgOf(trx, userId, workspaceId));
  if (!owner) throw new ForbiddenError('manageBilling');
  return orgId;
}

/** Client Stripe de l'organisation, créé au premier besoin. */
async function customerFor(db: Database, provider: BillingProvider, orgId: string, userId: string): Promise<string> {
  const known = await asSystem(db, (trx) => trx.selectFrom('organizations').select(['stripe_customer_id', 'name']).where('id', '=', orgId).executeTakeFirstOrThrow());
  if (known.stripe_customer_id !== null) return known.stripe_customer_id;
  const owner = await asSystem(db, (trx) => trx.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow());
  const customerId = await provider.createCustomer({ email: owner.email, name: known.name, orgId });
  await asSystem(db, (trx) => trx.updateTable('organizations').set({ stripe_customer_id: customerId }).where('id', '=', orgId).where('stripe_customer_id', 'is', null).execute());
  return (await asSystem(db, (trx) => trx.selectFrom('organizations').select('stripe_customer_id').where('id', '=', orgId).executeTakeFirstOrThrow())).stripe_customer_id as string;
}

/** FAC-01, FAC-03 : souscription par Stripe Checkout ; renvoie l'adresse de paiement. */
export async function startSubscription(
  db: Database,
  provider: BillingProvider,
  userId: string,
  workspaceId: string,
  input: { readonly planKey: string; readonly interval: 'month' | 'year' },
  urls: { readonly success: string; readonly cancel: string },
  now: Date,
): Promise<string> {
  const orgId = await requireOwner(db, userId, workspaceId);
  const plan = await asSystem(db, (trx) => trx.selectFrom('plans').selectAll().where('key', '=', input.planKey).where('active', '=', true).executeTakeFirst());
  const priceId = input.interval === 'year' ? plan?.stripe_price_yearly : plan?.stripe_price_monthly;
  if (plan === undefined || !priceId) throw new RefusedError('formule_indisponible', 'Cette formule n’est pas encore proposée à la souscription.');
  const existing = await asSystem(db, (trx) => trx.selectFrom('subscriptions').select('status').where('org_id', '=', orgId).where('status', 'in', ['active', 'past_due', 'unpaid']).executeTakeFirst());
  if (existing !== undefined) throw new RefusedError('deja_abonne', 'L’organisation a déjà un abonnement : changez de formule depuis le portail.');
  const quantity = Math.max(1, await asSystem(db, (trx) => billableAccounts(trx, orgId)));
  const customerId = await customerFor(db, provider, orgId, userId);
  const { url } = await provider.createCheckout({
    mode: 'subscription',
    customerId,
    priceId,
    quantity,
    successUrl: urls.success,
    cancelUrl: urls.cancel,
    metadata: { org_id: orgId, plan_key: plan.key },
  });
  await asUser(db, userId, (trx) => audit(trx, { workspaceId, actorUserId: userId, action: 'abonnement.paiement_demande', entity: 'organization', entityId: orgId, details: { plan: plan.key, interval: input.interval, quantity }, at: now }));
  return url;
}

/** FAC-05 : portail Stripe (moyen de paiement, factures, changement de formule, résiliation). */
export async function openBillingPortal(db: Database, provider: BillingProvider, userId: string, workspaceId: string, returnUrl: string): Promise<string> {
  const orgId = await requireOwner(db, userId, workspaceId);
  const org = await asSystem(db, (trx) => trx.selectFrom('organizations').select('stripe_customer_id').where('id', '=', orgId).executeTakeFirstOrThrow());
  if (org.stripe_customer_id === null) throw new RefusedError('pas_de_client', 'Aucun abonnement à gérer pour l’instant.');
  return (await provider.createPortal({ customerId: org.stripe_customer_id, returnUrl })).url;
}

/** FAC-04 : au plafond, rédaction suspendue ou packs supplémentaires. */
export async function setOveragePolicy(db: Database, userId: string, workspaceId: string, policy: 'suspend' | 'packs', now: Date): Promise<void> {
  if (policy !== 'suspend' && policy !== 'packs') throw new RefusedError('choix_inconnu', 'Choix inconnu.');
  const orgId = await requireOwner(db, userId, workspaceId);
  const updated = await asSystem(db, (trx) => trx.updateTable('subscriptions').set({ overage_policy: policy }).where('org_id', '=', orgId).returning('org_id').executeTakeFirst());
  if (updated === undefined) throw new RefusedError('pas_abonne', 'Ce réglage s’applique à un abonnement en cours.');
  await asUser(db, userId, (trx) => audit(trx, { workspaceId, actorUserId: userId, action: 'abonnement.depassement', entity: 'organization', entityId: orgId, details: { policy }, at: now }));
}

/** FAC-04 : achat d'un pack pour l'espace, valable sur la période en cours. */
export async function buyQuotaPack(
  db: Database,
  provider: BillingProvider,
  userId: string,
  workspaceId: string,
  offerKey: string,
  urls: { readonly success: string; readonly cancel: string },
): Promise<string> {
  const orgId = await requireOwner(db, userId, workspaceId);
  const sub = await asSystem(db, (trx) => trx.selectFrom('subscriptions').select(['status', 'overage_policy']).where('org_id', '=', orgId).executeTakeFirst());
  if (sub === undefined || sub.status !== 'active') throw new RefusedError('pas_abonne', 'Les packs s’ajoutent à un abonnement en cours.');
  if (sub.overage_policy !== 'packs') throw new RefusedError('packs_non_choisis', 'Choisissez d’abord « packs supplémentaires » au plafond.');
  const offer = await asSystem(db, (trx) => trx.selectFrom('quota_pack_offers').selectAll().where('key', '=', offerKey).where('active', '=', true).executeTakeFirst());
  if (offer === undefined || offer.stripe_price === null) throw new RefusedError('pack_indisponible', 'Ce pack n’est pas encore proposé.');
  const customerId = await customerFor(db, provider, orgId, userId);
  const { url } = await provider.createCheckout({
    mode: 'payment',
    customerId,
    priceId: offer.stripe_price,
    quantity: 1,
    successUrl: urls.success,
    cancelUrl: urls.cancel,
    metadata: { org_id: orgId, workspace_id: workspaceId, offer_key: offer.key, user_id: userId },
  });
  return url;
}

/** Applique un événement de facturation, une seule fois ; renvoie false s'il était déjà traité. */
export async function applyBillingEvent(db: Database, event: BillingEvent, now: Date): Promise<boolean> {
  return asSystem(db, async (trx) => {
    const fresh = await trx.insertInto('billing_events').values({ id: event.eventId, type: event.kind, received_at: now }).onConflict((oc) => oc.column('id').doNothing()).returning('id').executeTakeFirst();
    if (fresh === undefined) return false;
    switch (event.kind) {
      case 'subscription': {
        const org =
          event.orgId !== null
            ? await trx.selectFrom('organizations').select('id').where('id', '=', event.orgId).executeTakeFirst()
            : await trx.selectFrom('organizations').select('id').where('stripe_customer_id', '=', event.customerId).executeTakeFirst();
        if (org === undefined) return true;
        const plan = await trx
          .selectFrom('plans')
          .select('key')
          .where((eb) => eb.or([eb('stripe_price_monthly', '=', event.priceId), eb('stripe_price_yearly', '=', event.priceId)]))
          .executeTakeFirst();
        const current = await trx.selectFrom('subscriptions').select(['plan_key', 'past_due_since']).where('org_id', '=', org.id).executeTakeFirst();
        const planKey = plan?.key ?? current?.plan_key;
        if (planKey === undefined) return true;
        const values = {
          plan_key: planKey,
          stripe_subscription_id: event.subscriptionId,
          status: event.status,
          billing_interval: event.interval,
          quantity: event.quantity,
          current_period_start: event.periodStart,
          current_period_end: event.periodEnd,
          cancel_at_period_end: event.cancelAtPeriodEnd,
          // Une résiliation pendant un impayé garde la date de l'impayé : la suspension continue.
          past_due_since:
            event.status === 'past_due' || event.status === 'unpaid' ? (current?.past_due_since ?? now) : event.status === 'canceled' ? (current?.past_due_since ?? null) : null,
          updated_at: now,
          ...(event.status === 'active' && { reminders_sent: [] as string[] }),
        };
        await trx.insertInto('subscriptions').values({ org_id: org.id, ...values }).onConflict((oc) => oc.column('org_id').doUpdateSet(values)).execute();
        const unpaidCancel = event.status === 'canceled' && values.past_due_since !== null;
        await trx
          .updateTable('organizations')
          .set({ status: event.status === 'past_due' ? 'past_due' : event.status === 'unpaid' || unpaidCancel ? 'suspended' : 'active', stripe_customer_id: event.customerId })
          .where('id', '=', org.id)
          .execute();
        return true;
      }
      case 'payment_failed': {
        const failed = await trx
          .updateTable('subscriptions')
          .set((eb) => ({ status: 'past_due', past_due_since: eb.fn.coalesce('past_due_since', eb.val(now)), updated_at: now }))
          .where('stripe_subscription_id', '=', event.subscriptionId)
          .where('status', '<>', 'canceled')
          .returning('org_id')
          .executeTakeFirst();
        if (failed !== undefined) await trx.updateTable('organizations').set({ status: 'past_due' }).where('id', '=', failed.org_id).where('status', '=', 'active').execute();
        return true;
      }
      case 'payment_succeeded': {
        const paid = await trx
          .updateTable('subscriptions')
          .set({ status: 'active', past_due_since: null, reminders_sent: [], updated_at: now })
          .where('stripe_subscription_id', '=', event.subscriptionId)
          .where('status', 'in', ['past_due', 'unpaid', 'incomplete', 'active'])
          .returning('org_id')
          .executeTakeFirst();
        // Le règlement lève la suspension (FAC-06) : rédaction et publication reprennent.
        if (paid !== undefined) await trx.updateTable('organizations').set({ status: 'active' }).where('id', '=', paid.org_id).execute();
        return true;
      }
      case 'pack_paid': {
        const offer = await trx.selectFrom('quota_pack_offers').selectAll().where('key', '=', event.offerKey).executeTakeFirst();
        const ws = await trx.selectFrom('workspaces').select('org_id').where('id', '=', event.workspaceId).executeTakeFirst();
        const sub = ws === undefined ? undefined : await trx.selectFrom('subscriptions').select(['current_period_start', 'current_period_end']).where('org_id', '=', ws.org_id).executeTakeFirst();
        if (offer === undefined || sub === undefined) return true;
        // Le pack vaut pour le mois de quota en cours (RÈG-20).
        const window = quotaWindow(sub.current_period_start, sub.current_period_end, now);
        await trx
          .insertInto('quota_packs')
          .values({
            workspace_id: event.workspaceId,
            offer_key: offer.key,
            posts: offer.posts,
            images: offer.images,
            period_start: window.start,
            period_end: window.end,
            stripe_ref: event.ref,
            purchased_by: event.userId,
            created_at: now,
          })
          .onConflict((oc) => oc.column('stripe_ref').doNothing())
          .execute();
        return true;
      }
      default:
        return true;
    }
  });
}

/** FAC-02 : quantité facturée = comptes actifs ; ajout au prorata, retrait à la période suivante. */
export async function syncSubscriptionQuantities(db: Database, provider: BillingProvider, now: Date): Promise<{ updated: string[] }> {
  const subs = await asSystem(db, (trx) => trx.selectFrom('subscriptions').select(['org_id', 'stripe_subscription_id', 'quantity']).where('status', 'in', ['active', 'past_due']).execute());
  const updated: string[] = [];
  for (const sub of subs) {
    if (sub.stripe_subscription_id === null) continue;
    const accounts = Math.max(1, await asSystem(db, (trx) => billableAccounts(trx, sub.org_id)));
    if (accounts === sub.quantity) continue;
    await provider.updateQuantity({ subscriptionId: sub.stripe_subscription_id, quantity: accounts, prorate: accounts > sub.quantity });
    await asSystem(db, (trx) => trx.updateTable('subscriptions').set({ quantity: accounts, updated_at: now }).where('org_id', '=', sub.org_id).execute());
    updated.push(sub.org_id);
  }
  return { updated };
}

/** FAC-06 : relances à J+3 et J+7 ; à J+14, suspension (prise en compte par allowanceForWorkspace). */
export const DUNNING_STEPS = [
  { key: 'j3', days: 3 },
  { key: 'j7', days: 7 },
  { key: 'j14', days: UNPAID_SUSPENSION_DAYS },
] as const;

export interface DunningNotice {
  readonly orgId: string;
  readonly step: (typeof DUNNING_STEPS)[number]['key'];
  readonly ownerIds: readonly string[];
}

/** Relances dues ; chacune n'est renvoyée qu'une fois par impayé. L'appelant envoie les messages. */
export async function dueDunningNotices(db: Database, now: Date): Promise<DunningNotice[]> {
  return asSystem(db, async (trx) => {
    const subs = await trx.selectFrom('subscriptions').select(['org_id', 'past_due_since', 'reminders_sent']).where('past_due_since', 'is not', null).where('status', 'in', ['past_due', 'unpaid']).execute();
    const notices: DunningNotice[] = [];
    for (const sub of subs) {
      const days = (now.getTime() - (sub.past_due_since as Date).getTime()) / 86_400_000;
      const step = [...DUNNING_STEPS].reverse().find((s) => days >= s.days && !sub.reminders_sent.includes(s.key));
      if (step === undefined) continue;
      // Les relances plus anciennes sont considérées comme faites (pas de rafale).
      const done = DUNNING_STEPS.filter((s) => s.days <= step.days).map((s) => s.key);
      await trx.updateTable('subscriptions').set({ reminders_sent: [...new Set([...sub.reminders_sent, ...done])] }).where('org_id', '=', sub.org_id).execute();
      if (step.key === 'j14') await trx.updateTable('organizations').set({ status: 'suspended' }).where('id', '=', sub.org_id).execute();
      const owners = await trx.selectFrom('org_members').select('user_id').where('org_id', '=', sub.org_id).where('role', '=', 'owner').execute();
      notices.push({ orgId: sub.org_id, step: step.key, ownerIds: owners.map((o) => o.user_id) });
    }
    return notices;
  });
}

/** FAC-06 : données conservées 90 jours après la suspension, puis supprimées. */
export const SUSPENDED_DATA_RETENTION_DAYS = 90;

/**
 * Supprime les organisations suspendues pour impayé depuis plus de 90 jours (tout part en
 * cascade). Renvoie les fichiers de médias à effacer, que l'appelant supprime du stockage.
 */
export async function purgeExpiredSuspensions(db: Database, now: Date): Promise<{ readonly orgId: string; readonly orgName: string; readonly storageKeys: readonly string[] }[]> {
  const limit = new Date(now.getTime() - (UNPAID_SUSPENSION_DAYS + SUSPENDED_DATA_RETENTION_DAYS) * 86_400_000);
  return asSystem(db, async (trx) => {
    const doomed = await trx
      .selectFrom('subscriptions as s')
      .innerJoin('organizations as o', 'o.id', 's.org_id')
      .select(['o.id', 'o.name'])
      .where('o.status', '=', 'suspended')
      .where('s.status', 'in', ['past_due', 'unpaid', 'canceled'])
      .where('s.past_due_since', '<=', limit)
      .execute();
    const purged: { orgId: string; orgName: string; storageKeys: string[] }[] = [];
    for (const org of doomed) {
      const media = await trx
        .selectFrom('media_assets as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select('m.storage_key')
        .where('w.org_id', '=', org.id)
        .execute();
      await trx.deleteFrom('organizations').where('id', '=', org.id).execute();
      purged.push({ orgId: org.id, orgName: org.name, storageKeys: media.map((m) => m.storage_key) });
    }
    return purged;
  });
}

export interface UsageExportRow {
  readonly workspaceName: string;
  /** Mois civil, « AAAA-MM ». */
  readonly month: string;
  readonly posts: number;
  readonly images: number;
  readonly aiCostEur: number;
}

/**
 * FAC-07 : usage par espace et par mois civil, sur 12 mois, pour la refacturation des
 * agences à leurs clients (hors de l'outil). Réservé au propriétaire de l'organisation.
 */
export async function usageExport(db: Database, userId: string, workspaceId: string, now: Date, usdToEur: number): Promise<{ readonly orgName: string; readonly rows: readonly UsageExportRow[] }> {
  const orgId = await requireOwner(db, userId, workspaceId);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  return asSystem(db, async (trx) => {
    const org = await trx.selectFrom('organizations').select('name').where('id', '=', orgId).executeTakeFirstOrThrow();
    const rows = await trx
      .selectFrom('ai_usage as u')
      .innerJoin('workspaces as w', 'w.id', 'u.workspace_id')
      .select([
        'w.name as workspace_name',
        sql<string>`to_char(date_trunc('month', u.at at time zone 'Europe/Paris'), 'YYYY-MM')`.as('month'),
        sql<number>`(count(*) filter (where u.kind = 'text' and u.counted_in_quota))::int`.as('posts'),
        sql<number>`(coalesce(sum(u.units) filter (where u.kind = 'image' and u.counted_in_quota), 0))::int`.as('images'),
        sql<number>`coalesce(sum(u.cost_usd), 0)::float8`.as('cost_usd'),
      ])
      .where('w.org_id', '=', orgId)
      .where('u.at', '>=', since)
      .groupBy(['w.name', sql`2`])
      .orderBy('w.name')
      .orderBy(sql`2`)
      .execute();
    return {
      orgName: org.name,
      rows: rows.map((r) => ({ workspaceName: r.workspace_name, month: r.month, posts: r.posts, images: r.images, aiCostEur: Math.round(r.cost_usd * usdToEur * 100) / 100 })),
    };
  });
}

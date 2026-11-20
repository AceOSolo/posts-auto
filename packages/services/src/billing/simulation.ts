/**
 * Paiement simulé (BILLING_MODE=fake) : ce que Stripe ferait après un paiement ou une action
 * dans son portail, traduit en événements de facturation appliqués aussitôt. Réservé au
 * développement et aux démonstrations : l'application web ne l'expose qu'en mode simulé.
 */
import { randomUUID } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { ForbiddenError, RefusedError } from '../errors.ts';
import type { BillingEvent } from './stripe.ts';
import { applyBillingEvent } from './subscriptions.ts';

async function requireOrgOwner(db: Database, userId: string, orgId: string): Promise<void> {
  const owner = await asSystem(db, (trx) => trx.selectFrom('org_members').select('user_id').where('org_id', '=', orgId).where('user_id', '=', userId).where('role', '=', 'owner').executeTakeFirst());
  if (owner === undefined) throw new ForbiddenError('manageBilling');
}

const addInterval = (from: Date, interval: 'month' | 'year') => {
  const end = new Date(from);
  if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
};

/** Paiement simulé d'une session (abonnement ou pack), avec les paramètres de l'adresse de paiement. */
export async function completeSimulatedCheckout(
  db: Database,
  userId: string,
  input: { readonly mode: string; readonly customerId: string; readonly priceId: string; readonly quantity: number; readonly orgId: string; readonly workspaceId?: string; readonly offerKey?: string },
  now: Date,
): Promise<void> {
  await requireOrgOwner(db, userId, input.orgId);
  if (input.mode === 'payment') {
    if (!input.workspaceId || !input.offerKey) throw new RefusedError('simulation_invalide', 'Paiement simulé incomplet.');
    const ws = await asSystem(db, (trx) => trx.selectFrom('workspaces').select('id').where('id', '=', input.workspaceId as string).where('org_id', '=', input.orgId).executeTakeFirst());
    if (ws === undefined) throw new RefusedError('simulation_invalide', 'Paiement simulé incomplet.');
    await applyBillingEvent(db, { kind: 'pack_paid', eventId: `sim_${randomUUID()}`, workspaceId: ws.id, offerKey: input.offerKey, userId, ref: `cs_sim_${randomUUID()}` }, now);
    return;
  }
  const plan = await asSystem(db, (trx) =>
    trx
      .selectFrom('plans')
      .select(['stripe_price_monthly', 'stripe_price_yearly'])
      .where((eb) => eb.or([eb('stripe_price_monthly', '=', input.priceId), eb('stripe_price_yearly', '=', input.priceId)]))
      .executeTakeFirst(),
  );
  if (plan === undefined) throw new RefusedError('simulation_invalide', 'Formule inconnue.');
  const interval = plan.stripe_price_yearly === input.priceId ? 'year' : 'month';
  await applyBillingEvent(
    db,
    {
      kind: 'subscription',
      eventId: `sim_${randomUUID()}`,
      orgId: input.orgId,
      customerId: input.customerId,
      subscriptionId: `sub_sim_${input.orgId.replace(/-/g, '').slice(0, 16)}`,
      priceId: input.priceId,
      quantity: Math.max(1, input.quantity),
      status: 'active',
      interval,
      periodStart: now,
      periodEnd: addInterval(now, interval),
      cancelAtPeriodEnd: false,
    },
    now,
  );
}

export type SimulatedPortalAction = 'resilier' | 'reprendre' | 'echec_paiement' | 'paiement' | 'fin_resiliation';

/** Portail simulé : résiliation, reprise, échec ou réussite d'un prélèvement. */
export async function applySimulatedPortalAction(db: Database, userId: string, customerId: string, action: SimulatedPortalAction, now: Date): Promise<void> {
  const org = await asSystem(db, (trx) => trx.selectFrom('organizations').select('id').where('stripe_customer_id', '=', customerId).executeTakeFirst());
  if (org === undefined) throw new RefusedError('pas_de_client', 'Aucun abonnement à gérer pour l’instant.');
  await requireOrgOwner(db, userId, org.id);
  const sub = await asSystem(db, (trx) =>
    trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.key', 's.plan_key').selectAll('s').select(['p.stripe_price_monthly', 'p.stripe_price_yearly']).where('s.org_id', '=', org.id).executeTakeFirst(),
  );
  if (sub === undefined || sub.stripe_subscription_id === null) throw new RefusedError('pas_abonne', 'Ce réglage s’applique à un abonnement en cours.');
  const eventId = `sim_${randomUUID()}`;
  let event: BillingEvent;
  if (action === 'echec_paiement') event = { kind: 'payment_failed', eventId, subscriptionId: sub.stripe_subscription_id };
  else if (action === 'paiement') event = { kind: 'payment_succeeded', eventId, subscriptionId: sub.stripe_subscription_id };
  else {
    const priceId = (sub.billing_interval === 'year' ? sub.stripe_price_yearly : sub.stripe_price_monthly) ?? '';
    event = {
      kind: 'subscription',
      eventId,
      orgId: org.id,
      customerId,
      subscriptionId: sub.stripe_subscription_id,
      priceId,
      quantity: sub.quantity,
      status: action === 'fin_resiliation' ? 'canceled' : (sub.status as 'active' | 'past_due' | 'unpaid'),
      interval: sub.billing_interval as 'month' | 'year',
      periodStart: sub.current_period_start,
      periodEnd: sub.current_period_end,
      cancelAtPeriodEnd: action === 'resilier',
    };
  }
  await applyBillingEvent(db, event, now);
}

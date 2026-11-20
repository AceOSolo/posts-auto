/** Client Stripe par l'API REST (FAC-01, FAC-02, FAC-05) et traduction des événements. */
import { describe, expect, it } from 'vitest';
import { BillingError, FakeBilling, StripeBilling, parseStripeEvent } from './stripe.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function stripe(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: String(init.body ?? '') });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new StripeBilling({ secretKey: 'sk_test', fetch: impl }), calls };
}

describe('client Stripe', () => {
  it('client, paiement d’abonnement (carte + SEPA, TVA, codes promo) et de pack', async () => {
    const { client, calls } = stripe((url) => (url.endsWith('/v1/customers') ? json({ id: 'cus_1' }) : json({ url: 'https://checkout.stripe.test/s' })));
    expect(await client.createCustomer({ email: 'a@b.fr', name: 'Acme', orgId: 'o' })).toBe('cus_1');
    const request = { customerId: 'cus_1', priceId: 'price_1', quantity: 3, successUrl: 'https://app/ok', cancelUrl: 'https://app/ko', metadata: { org_id: 'o' } };
    expect(await client.createCheckout({ ...request, mode: 'subscription' })).toEqual({ url: 'https://checkout.stripe.test/s' });
    const subscription = decodeURIComponent(calls[1]?.body ?? '');
    expect(subscription).toContain('payment_method_types[1]=sepa_debit');
    expect(subscription).toContain('allow_promotion_codes=true');
    expect(subscription).toContain('automatic_tax[enabled]=true');
    expect(subscription).toContain('subscription_data[metadata][org_id]=o');
    await client.createCheckout({ ...request, mode: 'payment' });
    const pack = decodeURIComponent(calls[2]?.body ?? '');
    expect(pack).toContain('invoice_creation[enabled]=true');
    expect(pack).not.toContain('sepa_debit');
  });

  it('portail, quantité au prorata ou non, refus et panne', async () => {
    const { client, calls } = stripe((url) =>
      url.includes('billing_portal') ? json({ url: 'https://portal.stripe.test' }) : url.includes('/v1/subscriptions/') ? json({ items: { data: [{ id: 'si_1' }] } }) : json({}),
    );
    expect(await client.createPortal({ customerId: 'cus_1', returnUrl: 'https://app' })).toEqual({ url: 'https://portal.stripe.test' });
    await client.updateQuantity({ subscriptionId: 'sub_1', quantity: 4, prorate: true });
    expect(decodeURIComponent(calls.at(-1)?.body ?? '')).toBe('quantity=4&proration_behavior=create_prorations');
    await client.updateQuantity({ subscriptionId: 'sub_1', quantity: 2, prorate: false });
    expect(decodeURIComponent(calls.at(-1)?.body ?? '')).toContain('proration_behavior=none');

    const empty = stripe(() => json({ items: { data: [] } }));
    await expect(empty.client.updateQuantity({ subscriptionId: 's', quantity: 1, prorate: false })).rejects.toThrow(/sans ligne/);
    const noUrl = stripe(() => json({}));
    await expect(noUrl.client.createCheckout({ mode: 'payment', customerId: 'c', priceId: 'p', quantity: 1, successUrl: 'a', cancelUrl: 'b', metadata: {} })).rejects.toThrow(/adresse de paiement/);
    const refused = stripe(() => json({ error: { message: 'No such price' } }, 400));
    await expect(refused.client.createCustomer({ email: 'a', name: 'b', orgId: 'c' })).rejects.toThrow(/No such price/);
    const bare = stripe(() => new Response('oups', { status: 500 }));
    await expect(bare.client.createCustomer({ email: 'a', name: 'b', orgId: 'c' })).rejects.toThrow(/HTTP 500/);
    const offline = new StripeBilling({ secretKey: 'k', fetch: (async () => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch });
    await expect(offline.createPortal({ customerId: 'c', returnUrl: 'r' })).rejects.toBeInstanceOf(BillingError);
  });

  it('paiement simulé : adresses de l’application', async () => {
    const fake = new FakeBilling('https://app.test/');
    expect(await fake.createCustomer({ orgId: '12345678-aaaa' })).toBe('cus_sim_12345678aaaa');
    expect((await fake.createPortal({ customerId: 'cus', returnUrl: 'https://app.test/abonnement/x' })).url).toMatch(/^https:\/\/app\.test\/abonnement\/simulation\?mode=portail/);
  });
});

describe('événements Stripe', () => {
  const ORG = '00000000-0000-4000-8000-000000000001';
  const sub = (type: string, object: Record<string, unknown>) => parseStripeEvent({ id: 'evt', type, data: { object } });

  it('période sur l’abonnement ou sur sa ligne ; statuts traduits ; résiliation', () => {
    const base = { id: 'sub_1', customer: 'cus_1', metadata: { org_id: ORG }, items: { data: [{ price: { id: 'p' } }] } };
    expect(sub('customer.subscription.created', { ...base, status: 'active', current_period_start: 1, current_period_end: 2 })).toMatchObject({
      status: 'active',
      quantity: 1,
      interval: 'month',
      cancelAtPeriodEnd: false,
    });
    expect(sub('customer.subscription.updated', { ...base, status: 'past_due', current_period_start: 1, current_period_end: 2 })).toMatchObject({ status: 'past_due' });
    expect(sub('customer.subscription.updated', { ...base, status: 'paused', current_period_start: 1, current_period_end: 2 })).toMatchObject({ status: 'unpaid' });
    expect(sub('customer.subscription.updated', { ...base, status: 'inconnu', current_period_start: 1, current_period_end: 2 })).toMatchObject({ status: 'incomplete' });
    expect(sub('customer.subscription.deleted', { ...base, status: 'active', current_period_start: 1, current_period_end: 2 })).toMatchObject({ status: 'canceled' });
    expect(sub('customer.subscription.updated', { ...base, metadata: {}, status: 'active' })).toEqual({ kind: 'ignored', eventId: 'evt', type: 'customer.subscription.updated' });
    expect(sub('customer.subscription.updated', { status: 'active', current_period_start: 1, current_period_end: 2 })).toMatchObject({ orgId: null, priceId: '', customerId: '' });
  });

  it('factures : abonnement direct ou parent ; sans abonnement : ignorée', () => {
    expect(sub('invoice.paid', { subscription: 'sub_2' })).toEqual({ kind: 'payment_succeeded', eventId: 'evt', subscriptionId: 'sub_2' });
    expect(sub('invoice.payment_failed', {})).toMatchObject({ kind: 'ignored' });
  });

  it('pack payé seulement en paiement unique réglé, avec un espace valide', () => {
    const meta = { workspace_id: ORG, offer_key: 'pack-posts' };
    expect(sub('checkout.session.completed', { mode: 'payment', payment_status: 'unpaid', metadata: meta })).toMatchObject({ kind: 'ignored' });
    expect(sub('checkout.session.completed', { mode: 'subscription', metadata: meta })).toMatchObject({ kind: 'ignored' });
    expect(sub('checkout.session.completed', { mode: 'payment', metadata: { workspace_id: ORG } })).toMatchObject({ kind: 'ignored' });
    expect(sub('checkout.session.completed', { mode: 'payment', metadata: meta })).toMatchObject({ kind: 'pack_paid', ref: 'evt', userId: null });
    expect(parseStripeEvent({})).toEqual({ kind: 'ignored', eventId: '', type: '' });
  });
});

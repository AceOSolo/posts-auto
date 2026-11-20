import { createHmac } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { confirmSignup, requestSignup } from '../onboarding/signup.ts';
import { allowanceForWorkspace, quotaWindow } from './allowance.ts';
import { applySimulatedPortalAction, completeSimulatedCheckout } from './simulation.ts';
import { dueUsageAlerts } from './usage-alerts.ts';
import { type BillingEvent, BillingError, FakeBilling, formEncode, parseStripeEvent, verifyStripeSignature } from './stripe.ts';
import {
  applyBillingEvent,
  billingOverview,
  buyQuotaPack,
  dueDunningNotices,
  purgeExpiredSuspensions,
  setOveragePolicy,
  startSubscription,
  syncSubscriptionQuantities,
  usageExport,
} from './subscriptions.ts';

let db: Database;
let owner: string;
let admin: string;
let workspaceId: string;
let orgId: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const provider = new FakeBilling('http://localhost:3001');
const urls = { success: 'http://localhost:3001/abonnement/x?message=ok', cancel: 'http://localhost:3001/abonnement/x' };
const allowance = (now = NOW) => asSystem(db, (trx) => allowanceForWorkspace(trx, workspaceId, now));
let eventNo = 0;
const subscriptionEvent = (overrides: Partial<Extract<BillingEvent, { kind: 'subscription' }>> = {}): BillingEvent => ({
  kind: 'subscription',
  eventId: `evt_${(eventNo += 1)}`,
  orgId,
  customerId: 'cus_sim_1',
  subscriptionId: 'sub_1',
  priceId: 'price_ess_m',
  quantity: 2,
  status: 'active',
  interval: 'month',
  periodStart: NOW,
  periodEnd: days(30),
  cancelAtPeriodEnd: false,
  ...overrides,
});
const writePosts = (n: number, at = NOW) =>
  asSystem(db, (trx) =>
    trx
      .insertInto('ai_usage')
      .values(Array.from({ length: n }, () => ({ workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'write' as const, kind: 'text' as const, counted_in_quota: true, at })))
      .execute(),
  );

beforeAll(async () => {
  db = await openTestDatabase();
  const request = await requestSignup(db, { email: 'proprio@exemple.fr', fullName: 'Proprio', orgName: 'Client SARL', orgKind: 'entreprise' }, NOW);
  if (request.kind !== 'confirm') throw new Error(request.kind);
  const outcome = await confirmSignup(db, request.token, NOW);
  if (!outcome.ok) throw new Error('inscription');
  owner = outcome.session.userId;
  workspaceId = outcome.workspaceId;
  orgId = (await asSystem(db, (trx) => trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow())).org_id;
  admin = await createUser(db, 'admin');
  await addMember(db, workspaceId, admin, 'admin');
  await createAccount(db, workspaceId);
  await createAccount(db, workspaceId);
  await asSystem(db, async (trx) => {
    await trx.updateTable('plans').set({ stripe_price_monthly: 'price_ess_m', stripe_price_yearly: 'price_ess_y' }).where('key', '=', 'essentiel').execute();
    await trx.updateTable('quota_pack_offers').set({ stripe_price: 'price_pack_posts' }).where('key', '=', 'pack-posts').execute();
  });
});
afterAll(() => closeTestDatabase(db));

const ORG9 = '00000000-0000-4000-8000-000000000009';
const WS9 = '00000000-0000-4000-8000-0000000000a9';

describe('mois de quota (RÈG-20)', () => {
  it('remis à zéro chaque mois à la date anniversaire, même en annuel', () => {
    const start = new Date('2026-01-31T09:00:00Z');
    const end = new Date('2027-01-31T09:00:00Z');
    expect(quotaWindow(start, end, new Date('2026-02-10T00:00:00Z'))).toEqual({ start, end: new Date('2026-02-28T09:00:00Z') });
    expect(quotaWindow(start, end, new Date('2026-03-01T00:00:00Z'))).toEqual({ start: new Date('2026-02-28T09:00:00Z'), end: new Date('2026-03-31T09:00:00Z') });
    expect(quotaWindow(start, end, new Date('2027-01-30T00:00:00Z'))).toEqual({ start: new Date('2026-12-31T09:00:00Z'), end });
    expect(quotaWindow(NOW, days(30), days(29))).toEqual({ start: NOW, end: days(30) });
  });
});

describe('Stripe : formulaire, signature, événements', () => {
  it('met les paramètres imbriqués à plat', () => {
    expect(formEncode({ mode: 'subscription', line_items: [{ price: 'p', quantity: 2 }], metadata: { org_id: 'o' }, payment_method_types: ['card', 'sepa_debit'] })).toEqual([
      'mode=subscription',
      'line_items%5B0%5D%5Bprice%5D=p',
      'line_items%5B0%5D%5Bquantity%5D=2',
      'metadata%5Borg_id%5D=o',
      'payment_method_types%5B0%5D=card',
      'payment_method_types%5B1%5D=sepa_debit',
    ]);
  });

  it('vérifie la signature d’un événement', () => {
    const payload = '{"id":"evt_1"}';
    const t = Math.floor(NOW.getTime() / 1000);
    const signature = createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
    expect(() => verifyStripeSignature(payload, `t=${t},v1=${signature}`, 'whsec_test', NOW)).not.toThrow();
    expect(() => verifyStripeSignature(payload, `t=${t},v1=${signature}`, 'autre', NOW)).toThrow(BillingError);
    expect(() => verifyStripeSignature(`${payload} `, `t=${t},v1=${signature}`, 'whsec_test', NOW)).toThrow(/invalide/);
    expect(() => verifyStripeSignature(payload, `t=${t},v1=${signature}`, 'whsec_test', days(1))).toThrow(/ancienne/);
    expect(() => verifyStripeSignature(payload, null, 'whsec_test', NOW)).toThrow(/absente/);
  });

  it('traduit les événements Stripe utiles, ignore les autres', () => {
    const sub = parseStripeEvent({
      id: 'evt_a',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_9',
          customer: 'cus_9',
          status: 'trialing',
          cancel_at_period_end: true,
          metadata: { org_id: ORG9 },
          items: { data: [{ quantity: 4, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000, price: { id: 'price_x', recurring: { interval: 'year' } } }] },
        },
      },
    });
    expect(sub).toMatchObject({ kind: 'subscription', orgId: ORG9, status: 'active', quantity: 4, interval: 'year', cancelAtPeriodEnd: true, priceId: 'price_x' });
    expect(parseStripeEvent({ id: 'evt_b', type: 'invoice.payment_failed', data: { object: { parent: { subscription_details: { subscription: 'sub_9' } } } } })).toEqual({
      kind: 'payment_failed',
      eventId: 'evt_b',
      subscriptionId: 'sub_9',
    });
    expect(
      parseStripeEvent({
        id: 'evt_c',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', metadata: { workspace_id: WS9, offer_key: 'pack-posts', user_id: 'pas-un-uuid' } } },
      }),
    ).toEqual({ kind: 'pack_paid', eventId: 'evt_c', workspaceId: WS9, offerKey: 'pack-posts', userId: null, ref: 'cs_1' });
    expect(parseStripeEvent({ id: 'evt_e', type: 'checkout.session.completed', data: { object: { id: 'cs_2', mode: 'payment', metadata: { workspace_id: 'ws', offer_key: 'pack-posts' } } } }).kind).toBe(
      'ignored',
    );
    expect(parseStripeEvent({ id: 'evt_d', type: 'customer.created', data: { object: {} } })).toEqual({ kind: 'ignored', eventId: 'evt_d', type: 'customer.created' });
  });
});

describe('abonnement (FAC-01 à FAC-06)', () => {
  it('seul le propriétaire souscrit ; une formule sans prix n’est pas proposée', async () => {
    await expect(startSubscription(db, provider, admin, workspaceId, { planKey: 'essentiel', interval: 'month' }, urls, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startSubscription(db, provider, owner, workspaceId, { planKey: 'pro', interval: 'month' }, urls, NOW)).rejects.toMatchObject({ code: 'formule_indisponible' });
    const url = await startSubscription(db, provider, owner, workspaceId, { planKey: 'essentiel', interval: 'month' }, urls, NOW);
    expect(url).toContain('/abonnement/simulation?mode=subscription');
    expect(new URL(url).searchParams.get('quantite')).toBe('2');
    const overview = await billingOverview(db, owner, workspaceId, NOW);
    expect(overview).toMatchObject({ canManage: true, subscription: null, billableAccounts: 2 });
    expect(overview.plans.find((p) => p.key === 'essentiel')).toMatchObject({ monthly: true, yearly: true, postsPerAccount: 16 });
    expect(overview.plans.find((p) => p.key === 'pro')).toMatchObject({ monthly: false });
  });

  it('l’abonnement reçu de Stripe remplace l’essai : quota par compte, mutualisé dans l’espace', async () => {
    const event = subscriptionEvent();
    expect(await applyBillingEvent(db, event, NOW)).toBe(true);
    expect(await applyBillingEvent(db, event, NOW)).toBe(false);
    await writePosts(3, days(-1)); // avant la période : ne compte pas
    await writePosts(5, NOW);
    const a = await allowance();
    expect(a).toMatchObject({ mode: 'subscribed', planKey: 'essentiel', canPublish: true, posts: { used: 5, limit: 32, remaining: 27 } });
  });

  it('au plafond : rédaction suspendue, ou pack acheté si le client l’a choisi', async () => {
    await writePosts(21, NOW); // 26 sur 32 : 81 %
    expect(await dueUsageAlerts(db, NOW)).toEqual([expect.objectContaining({ workspaceId, kind: 'posts_80', used: 26, limit: 32, recipientIds: expect.arrayContaining([owner, admin]) })]);
    expect(await dueUsageAlerts(db, NOW)).toEqual([]);
    await writePosts(6, NOW);
    expect((await dueUsageAlerts(db, NOW)).map((a) => a.kind)).toEqual(['posts_100']);
    expect(await allowance()).toMatchObject({ posts: { remaining: 0 }, reason: expect.stringMatching(/mois de quota suivant/) });
    await expect(buyQuotaPack(db, provider, owner, workspaceId, 'pack-posts', urls)).rejects.toMatchObject({ code: 'packs_non_choisis' });
    await setOveragePolicy(db, owner, workspaceId, 'packs', NOW);
    expect((await allowance()).reason).toMatch(/achetez un pack/);
    const url = await buyQuotaPack(db, provider, owner, workspaceId, 'pack-posts', urls);
    expect(new URL(url).searchParams.get('offer_key')).toBe('pack-posts');
    await applyBillingEvent(db, { kind: 'pack_paid', eventId: 'evt_pack', workspaceId, offerKey: 'pack-posts', userId: owner, ref: 'cs_pack' }, NOW);
    expect((await allowance()).posts).toEqual({ used: 32, limit: 52, remaining: 20 });
  });

  it('quantité facturée = comptes actifs : ajout au prorata', async () => {
    await createAccount(db, workspaceId);
    expect(await syncSubscriptionQuantities(db, provider, NOW)).toEqual({ updated: [orgId] });
    expect(provider.quantities.get('sub_1')).toBe(3);
    expect(await syncSubscriptionQuantities(db, provider, NOW)).toEqual({ updated: [] });
  });

  it('impayé : relances à J+3 et J+7, suspension à J+14, reprise au règlement', async () => {
    await applyBillingEvent(db, { kind: 'payment_failed', eventId: 'evt_f1', subscriptionId: 'sub_1' }, NOW);
    expect(await allowance(days(2))).toMatchObject({ mode: 'subscribed', canPublish: true });
    expect(await dueDunningNotices(db, days(1))).toEqual([]);
    expect(await dueDunningNotices(db, days(3))).toEqual([{ orgId, step: 'j3', ownerIds: [owner] }]);
    expect(await dueDunningNotices(db, days(4))).toEqual([]);
    expect((await dueDunningNotices(db, days(7)))[0]?.step).toBe('j7');
    const suspended = await allowance(days(14));
    expect(suspended).toMatchObject({ mode: 'suspended', canPublish: false, posts: { remaining: 0 } });
    expect((await dueDunningNotices(db, days(14)))[0]?.step).toBe('j14');
    expect((await asSystem(db, (trx) => trx.selectFrom('organizations').select('status').where('id', '=', orgId).executeTakeFirstOrThrow())).status).toBe('suspended');

    await applyBillingEvent(db, { kind: 'payment_succeeded', eventId: 'evt_p1', subscriptionId: 'sub_1' }, days(15));
    expect(await allowance(days(15))).toMatchObject({ mode: 'subscribed', canPublish: true });
    expect((await asSystem(db, (trx) => trx.selectFrom('organizations').select('status').where('id', '=', orgId).executeTakeFirstOrThrow())).status).toBe('active');
  });

  it('résiliation reçue de Stripe : plus de rédaction, la publication continue', async () => {
    await applyBillingEvent(db, subscriptionEvent({ status: 'canceled' }), days(20));
    expect(await allowance(days(20))).toMatchObject({ mode: 'trial_over', canPublish: true, posts: { remaining: 0 }, reason: expect.stringMatching(/résilié/) });
  });

  it('FAC-07 : usage par espace et par mois, pour le propriétaire seulement', async () => {
    const data = await usageExport(db, owner, workspaceId, NOW, 0.9);
    expect(data.rows).toEqual([expect.objectContaining({ month: '2026-11', posts: 35, images: 0 })]);
    await expect(usageExport(db, admin, workspaceId, NOW, 0.9)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('paiement simulé, résiliation pour impayé, suppression à J+14+90 (FAC-06)', () => {
  let ws: string;
  let org: string;
  let boss: string;
  beforeAll(async () => {
    const request = await requestSignup(db, { email: 'agence@exemple.fr', fullName: 'Agence', orgName: 'Agence SAS', orgKind: 'agence' }, NOW);
    if (request.kind !== 'confirm') throw new Error(request.kind);
    const outcome = await confirmSignup(db, request.token, NOW);
    if (!outcome.ok) throw new Error('inscription');
    boss = outcome.session.userId;
    ws = outcome.workspaceId;
    org = (await asSystem(db, (trx) => trx.selectFrom('workspaces').select('org_id').where('id', '=', ws).executeTakeFirstOrThrow())).org_id;
    await createAccount(db, ws);
  });
  const allowanceOf = (now: Date) => asSystem(db, (trx) => allowanceForWorkspace(trx, ws, now));

  it('« Payer » en simulation crée l’abonnement ; un autre que le propriétaire est refusé', async () => {
    const input = { mode: 'subscription', customerId: 'cus_sim_agence', priceId: 'price_ess_y', quantity: 1, orgId: org };
    await expect(completeSimulatedCheckout(db, owner, input, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await completeSimulatedCheckout(db, boss, input, NOW);
    expect((await billingOverview(db, boss, ws, NOW)).subscription).toMatchObject({ planKey: 'essentiel', interval: 'year', status: 'active' });
    // Annuel : le quota repart chaque mois à la date anniversaire.
    expect((await allowanceOf(days(40))).periodStart).toEqual(new Date('2026-12-20T10:00:00Z'));
  });

  it('résilié pendant un impayé : la suspension continue, puis tout est supprimé après 90 jours', async () => {
    await applySimulatedPortalAction(db, boss, 'cus_sim_agence', 'echec_paiement', NOW);
    await applySimulatedPortalAction(db, boss, 'cus_sim_agence', 'fin_resiliation', days(20));
    expect(await allowanceOf(days(21))).toMatchObject({ mode: 'suspended', canPublish: false });
    expect(await purgeExpiredSuspensions(db, days(100))).toEqual([]);
    await asSystem(db, (trx) => trx.insertInto('media_assets').values({ workspace_id: ws, kind: 'upload', storage_key: `ws/${ws}/photo.png`, mime: 'image/png' }).execute());
    expect(await purgeExpiredSuspensions(db, days(105))).toEqual([{ orgId: org, orgName: 'Agence SAS', storageKeys: [`ws/${ws}/photo.png`] }]);
    expect(await asSystem(db, (trx) => trx.selectFrom('workspaces').select('id').where('id', '=', ws).executeTakeFirst())).toBeUndefined();
    // L'autre client n'est pas touché.
    expect(await asSystem(db, (trx) => trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst())).toBeDefined();
  });
});

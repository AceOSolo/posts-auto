/**
 * Fournisseur de paiement (FAC-01, FAC-02, FAC-05) : Stripe par son API REST, ou simulé
 * (BILLING_MODE=fake) pour le développement et les tests.
 *
 * - Souscription : Stripe Checkout (carte et prélèvement SEPA, TVA calculée par Stripe,
 *   numéro de TVA intracommunautaire collecté pour l'autoliquidation, codes promo FAC-03).
 * - Portail client Stripe : moyen de paiement, factures, résiliation (FAC-05).
 * - Quantité facturée = comptes actifs (FAC-02) : ajout au prorata, retrait à la période
 *   suivante.
 * - Événements : signature vérifiée (HMAC-SHA256, 5 minutes de tolérance), puis traduits en
 *   événements internes (BillingEvent) : le reste du code ne dépend pas de Stripe.
 *
 * La facture électronique passe par une plateforme agréée raccordée à Stripe (FAC-01, M10) :
 * hors du code, à brancher côté Stripe.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CheckoutRequest {
  readonly mode: 'subscription' | 'payment';
  readonly customerId: string;
  readonly priceId: string;
  readonly quantity: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Recopié sur la session et l'abonnement : relie l'événement à l'organisation. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface BillingProvider {
  readonly name: 'stripe' | 'simulation';
  createCustomer(input: { readonly email: string; readonly name: string; readonly orgId: string }): Promise<string>;
  createCheckout(request: CheckoutRequest): Promise<{ readonly url: string }>;
  createPortal(input: { readonly customerId: string; readonly returnUrl: string }): Promise<{ readonly url: string }>;
  updateQuantity(input: { readonly subscriptionId: string; readonly quantity: number; readonly prorate: boolean }): Promise<void>;
}

export class BillingError extends Error {
  override readonly name = 'BillingError';
}

/** Événement de facturation, indépendant de Stripe. */
export type BillingEvent =
  | {
      readonly kind: 'subscription';
      readonly eventId: string;
      readonly orgId: string | null;
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly priceId: string;
      readonly quantity: number;
      readonly status: 'incomplete' | 'active' | 'past_due' | 'unpaid' | 'canceled';
      readonly interval: 'month' | 'year';
      readonly periodStart: Date;
      readonly periodEnd: Date;
      readonly cancelAtPeriodEnd: boolean;
    }
  | { readonly kind: 'payment_failed'; readonly eventId: string; readonly subscriptionId: string }
  | { readonly kind: 'payment_succeeded'; readonly eventId: string; readonly subscriptionId: string }
  | { readonly kind: 'pack_paid'; readonly eventId: string; readonly workspaceId: string; readonly offerKey: string; readonly userId: string | null; readonly ref: string }
  | { readonly kind: 'ignored'; readonly eventId: string; readonly type: string };

/** Paramètres d'un formulaire Stripe : objets et listes à plat (« a[b][0]=… »). */
export function formEncode(value: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const name = prefix === '' ? key : `${prefix}[${key}]`;
    if (item === undefined || item === null) continue;
    if (Array.isArray(item)) item.forEach((v, i) => parts.push(...(typeof v === 'object' && v !== null ? formEncode(v as Record<string, unknown>, `${name}[${i}]`) : [`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(v))}`])));
    else if (typeof item === 'object') parts.push(...formEncode(item as Record<string, unknown>, name));
    else parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(item))}`);
  }
  return parts;
}

export class StripeBilling implements BillingProvider {
  readonly name = 'stripe';
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: { readonly secretKey: string; readonly fetch?: typeof fetch }) {
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`https://api.stripe.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#secretKey}`, ...(body && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      ...(body && { body: formEncode(body).join('&') }),
      signal: AbortSignal.timeout(20_000),
    }).catch((error: unknown) => {
      throw new BillingError(`Stripe injoignable (${error instanceof Error ? error.message : String(error)})`);
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = (json['error'] as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
      throw new BillingError(`Stripe a refusé la demande : ${message}`);
    }
    return json;
  }

  async createCustomer(input: { email: string; name: string; orgId: string }): Promise<string> {
    const customer = await this.#call('POST', '/v1/customers', { email: input.email, name: input.name, metadata: { org_id: input.orgId }, preferred_locales: ['fr'] });
    return String(customer['id']);
  }

  async createCheckout(request: CheckoutRequest): Promise<{ url: string }> {
    const session = await this.#call('POST', '/v1/checkout/sessions', {
      mode: request.mode,
      customer: request.customerId,
      line_items: [{ price: request.priceId, quantity: request.quantity }],
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      metadata: request.metadata,
      locale: 'fr',
      payment_method_types: request.mode === 'subscription' ? ['card', 'sepa_debit'] : ['card'],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      ...(request.mode === 'subscription' && { allow_promotion_codes: true, subscription_data: { metadata: request.metadata } }),
      ...(request.mode === 'payment' && { invoice_creation: { enabled: true } }),
    });
    if (typeof session['url'] !== 'string') throw new BillingError('Stripe n’a pas renvoyé d’adresse de paiement.');
    return { url: session['url'] };
  }

  async createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const session = await this.#call('POST', '/v1/billing_portal/sessions', { customer: input.customerId, return_url: input.returnUrl, locale: 'fr' });
    return { url: String(session['url']) };
  }

  async updateQuantity(input: { subscriptionId: string; quantity: number; prorate: boolean }): Promise<void> {
    const subscription = await this.#call('GET', `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`);
    const item = ((subscription['items'] as { data?: { id: string }[] } | undefined)?.data ?? [])[0];
    if (item === undefined) throw new BillingError('Abonnement Stripe sans ligne.');
    await this.#call('POST', `/v1/subscription_items/${encodeURIComponent(item.id)}`, { quantity: input.quantity, proration_behavior: input.prorate ? 'create_prorations' : 'none' });
  }
}

/** Vérifie la signature d'un événement Stripe (en-tête Stripe-Signature) ; lève BillingError sinon. */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, now: Date, toleranceSeconds = 300): void {
  if (header === null) throw new BillingError('Signature absente.');
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(timestamp) || signatures.length === 0) throw new BillingError('Signature illisible.');
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) throw new BillingError('Signature trop ancienne.');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  const ok = signatures.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new BillingError('Signature invalide.');
}

const STATUS: Record<string, 'incomplete' | 'active' | 'past_due' | 'unpaid' | 'canceled'> = {
  trialing: 'active',
  active: 'active',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'canceled',
  paused: 'unpaid',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identifiant interne lu dans les métadonnées : ignoré s'il n'a pas la forme attendue. */
const uuidOrNull = (value: unknown): string | null => (typeof value === 'string' && UUID.test(value) ? value : null);

const seconds = (value: unknown): Date | null => (typeof value === 'number' ? new Date(value * 1000) : null);

/** Traduit un événement Stripe (déjà vérifié) en événement interne. */
export function parseStripeEvent(event: Record<string, unknown>): BillingEvent {
  const eventId = String(event['id'] ?? '');
  const type = String(event['type'] ?? '');
  const object = ((event['data'] as { object?: Record<string, unknown> } | undefined)?.object ?? {}) as Record<string, unknown>;
  const metadata = (object['metadata'] ?? {}) as Record<string, string>;
  if (type === 'customer.subscription.created' || type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const item = (((object['items'] as { data?: Record<string, unknown>[] } | undefined)?.data ?? [])[0] ?? {}) as Record<string, unknown>;
    const price = (item['price'] ?? {}) as Record<string, unknown>;
    // Selon la version de l'API, la période est sur l'abonnement ou sur sa ligne.
    const periodStart = seconds(object['current_period_start']) ?? seconds(item['current_period_start']);
    const periodEnd = seconds(object['current_period_end']) ?? seconds(item['current_period_end']);
    if (periodStart === null || periodEnd === null) return { kind: 'ignored', eventId, type };
    return {
      kind: 'subscription',
      eventId,
      orgId: uuidOrNull(metadata['org_id']),
      customerId: String(object['customer'] ?? ''),
      subscriptionId: String(object['id'] ?? ''),
      priceId: String(price['id'] ?? ''),
      quantity: typeof item['quantity'] === 'number' ? item['quantity'] : 1,
      status: type === 'customer.subscription.deleted' ? 'canceled' : (STATUS[String(object['status'])] ?? 'incomplete'),
      interval: (price['recurring'] as { interval?: string } | undefined)?.interval === 'year' ? 'year' : 'month',
      periodStart,
      periodEnd,
      cancelAtPeriodEnd: object['cancel_at_period_end'] === true,
    };
  }
  const invoiceSubscription = (): string | null => {
    const direct = object['subscription'];
    if (typeof direct === 'string') return direct;
    const parent = (object['parent'] as { subscription_details?: { subscription?: string } } | undefined)?.subscription_details?.subscription;
    return typeof parent === 'string' ? parent : null;
  };
  if (type === 'invoice.payment_failed' || type === 'invoice.paid') {
    const subscriptionId = invoiceSubscription();
    if (subscriptionId === null) return { kind: 'ignored', eventId, type };
    return type === 'invoice.paid' ? { kind: 'payment_succeeded', eventId, subscriptionId } : { kind: 'payment_failed', eventId, subscriptionId };
  }
  const packWorkspace = uuidOrNull(metadata['workspace_id']);
  if (type === 'checkout.session.completed' && object['mode'] === 'payment' && object['payment_status'] !== 'unpaid' && packWorkspace !== null && metadata['offer_key']) {
    return { kind: 'pack_paid', eventId, workspaceId: packWorkspace, offerKey: metadata['offer_key'], userId: uuidOrNull(metadata['user_id']), ref: String(object['id'] ?? eventId) };
  }
  return { kind: 'ignored', eventId, type };
}

/**
 * Paiement simulé (BILLING_MODE=fake) : la page de paiement est une page de l'application
 * qui applique directement les événements (paiement réussi). Jamais en production.
 */
export class FakeBilling implements BillingProvider {
  readonly name = 'simulation';
  readonly #appUrl: string;
  readonly quantities = new Map<string, number>();

  constructor(appUrl: string) {
    this.#appUrl = appUrl.replace(/\/$/, '');
  }

  async createCustomer(input: { orgId: string }): Promise<string> {
    return `cus_sim_${input.orgId.replace(/-/g, '').slice(0, 14)}`;
  }

  async createCheckout(request: CheckoutRequest): Promise<{ url: string }> {
    const params = new URLSearchParams({ mode: request.mode, client: request.customerId, prix: request.priceId, quantite: String(request.quantity), retour: request.successUrl, ...request.metadata });
    return { url: `${this.#appUrl}/abonnement/simulation?${params.toString()}` };
  }

  async createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const params = new URLSearchParams({ mode: 'portail', client: input.customerId, retour: input.returnUrl });
    return { url: `${this.#appUrl}/abonnement/simulation?${params.toString()}` };
  }

  async updateQuantity(input: { subscriptionId: string; quantity: number }): Promise<void> {
    this.quantities.set(input.subscriptionId, input.quantity);
  }
}

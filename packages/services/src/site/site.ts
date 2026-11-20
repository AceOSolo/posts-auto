/**
 * Site vitrine (SIT-01 à SIT-03, SIT-08) : formules affichées, simulateur de prix, demandes
 * de démonstration et témoignage client.
 *
 * - Les tarifs viennent des formules en base (prix affichés, décision 0007) : un seul endroit
 *   à tenir à jour.
 * - Demande de démonstration : enregistrée, envoyée par e-mail à l'éditeur (SALES_EMAIL) et,
 *   si DEMO_WEBHOOK_URL est défini, à son CRM (POST JSON). 5 demandes par heure et par
 *   adresse IP ; champ piège contre les robots.
 * - Témoignage (SIT-08) : affiché seulement s'il a été saisi dans le back-office, avec la
 *   date de l'accord écrit du client. Aucun témoignage n'est inventé.
 */
import { type Database, asSystem } from '@posts-auto/db';
import { sql } from 'kysely';
import { requirePlatformAdmin } from '../admin/platform.ts';
import { normalizeEmail } from '../auth/auth.ts';
import { RefusedError } from '../errors.ts';

export interface PublicPlan {
  readonly key: string;
  readonly name: string;
  readonly postsPerAccount: number;
  readonly imagesPerAccount: number | null;
  readonly maxWorkspaces: number | null;
  readonly features: readonly string[];
  readonly priceMonthlyCents: number | null;
  readonly priceYearlyCents: number | null;
}

export async function publicPlans(db: Database): Promise<PublicPlan[]> {
  const rows = await asSystem(db, (trx) => trx.selectFrom('plans').selectAll().where('active', '=', true).orderBy('position').execute());
  return rows.map((p) => ({
    key: p.key,
    name: p.name,
    postsPerAccount: p.posts_per_account,
    imagesPerAccount: p.images_per_account,
    maxWorkspaces: p.max_workspaces,
    features: p.features,
    priceMonthlyCents: p.price_monthly_cents,
    priceYearlyCents: p.price_yearly_cents,
  }));
}

export interface PriceSimulation {
  readonly plan: PublicPlan;
  readonly accounts: number;
  /** Prix mensuel hors taxes ; null si le prix de la formule n'est pas encore fixé. */
  readonly monthlyCents: number | null;
  /** Équivalent mensuel en paiement annuel. */
  readonly yearlyMonthlyCents: number | null;
  /** Palier d'IA : posts rédigés par mois, mutualisés entre les comptes de l'espace. */
  readonly postsPerMonth: number;
}

/** SIT-03 : nombre de profils et de pages → prix mensuel, et posts rédigés inclus. */
export function simulatePrice(plans: readonly PublicPlan[], profiles: number, pages: number): PriceSimulation[] {
  const accounts = Math.max(1, Math.min(500, Math.floor(profiles) + Math.floor(pages)));
  return plans.map((plan) => ({
    plan,
    accounts,
    monthlyCents: plan.priceMonthlyCents === null ? null : plan.priceMonthlyCents * accounts,
    yearlyMonthlyCents: plan.priceYearlyCents === null ? null : Math.round((plan.priceYearlyCents * accounts) / 12),
    postsPerMonth: plan.postsPerAccount * accounts,
  }));
}

export const DEMO_REQUESTS_PER_IP_PER_HOUR = 5;

export interface DemoRequestInput {
  readonly fullName: string;
  readonly company: string;
  readonly email: string;
  readonly phone: string;
  readonly accounts: string;
  readonly message: string;
  /** Champ piège, invisible : rempli par les robots seulement. */
  readonly website: string;
}

export interface DemoNotifier {
  notify(request: { readonly id: string; readonly fullName: string; readonly company: string; readonly email: string; readonly phone: string | null; readonly accounts: number | null; readonly message: string | null }): Promise<void>;
}

/** SIT-02 : enregistre la demande, puis la transmet (e-mail, CRM) ; renvoie son identifiant. */
export async function createDemoRequest(db: Database, notifier: DemoNotifier, input: DemoRequestInput, now: Date, ip?: string): Promise<string | null> {
  if (input.website.trim() !== '') return null; // robot : on répond comme si de rien n'était
  const fullName = input.fullName.trim().slice(0, 120);
  const company = input.company.trim().slice(0, 160);
  const email = normalizeEmail(input.email);
  if (fullName === '' || company === '') throw new RefusedError('demo_incomplete', 'Indiquez votre nom et votre entreprise.');
  if (email === null) throw new RefusedError('email_invalide', 'Adresse e-mail invalide.');
  const phone = input.phone.trim().slice(0, 40) || null;
  const parsed = Number.parseInt(input.accounts, 10);
  const accounts = Number.isInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : null;
  const message = input.message.trim().slice(0, 2000) || null;
  const id = await asSystem(db, async (trx) => {
    if (ip !== undefined) {
      const recent = await trx
        .selectFrom('demo_requests')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('requested_ip', '=', ip)
        .where('created_at', '>', new Date(now.getTime() - 3_600_000))
        .executeTakeFirstOrThrow();
      if (recent.n >= DEMO_REQUESTS_PER_IP_PER_HOUR) throw new RefusedError('trop', 'Trop de demandes : réessayez plus tard.');
    }
    const row = await trx
      .insertInto('demo_requests')
      .values({ full_name: fullName, company, email, phone, accounts, message, requested_ip: ip ?? null, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
  try {
    await notifier.notify({ id, fullName, company, email, phone, accounts, message });
    await asSystem(db, (trx) => trx.updateTable('demo_requests').set({ forwarded_at: new Date() }).where('id', '=', id).execute());
  } catch (error) {
    // La demande est gardée : l'éditeur la retrouve dans le back-office.
    await asSystem(db, (trx) => trx.updateTable('demo_requests').set({ forward_error: error instanceof Error ? error.message.slice(0, 300) : 'erreur' }).where('id', '=', id).execute());
  }
  return id;
}

/** Demandes de démonstration récentes (back-office). */
export async function listDemoRequests(db: Database, adminId: string) {
  await requirePlatformAdmin(db, adminId);
  return asSystem(db, (trx) =>
    trx
      .selectFrom('demo_requests')
      .select(['id', 'full_name as fullName', 'company', 'email', 'phone', 'accounts', 'message', 'forwarded_at as forwardedAt', 'forward_error as forwardError', 'created_at as createdAt'])
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute(),
  );
}

export interface Testimonial {
  readonly quote: string;
  readonly author: string;
  readonly role: string;
  readonly company: string;
  /** Date de l'accord écrit du client (SIT-08). */
  readonly consentOn: string;
}

const TESTIMONIAL_KEY = 'site_testimonial';

export async function siteTestimonial(db: Database): Promise<Testimonial | null> {
  const row = await asSystem(db, (trx) => trx.selectFrom('platform_settings').select('value').where('key', '=', TESTIMONIAL_KEY).executeTakeFirst());
  const value = row?.value as Partial<Testimonial> | null | undefined;
  if (!value || typeof value.quote !== 'string' || typeof value.author !== 'string' || typeof value.consentOn !== 'string') return null;
  return { quote: value.quote, author: value.author, role: value.role ?? '', company: value.company ?? '', consentOn: value.consentOn };
}

/** Saisie du témoignage dans le back-office ; un texte vide le retire. */
export async function saveSiteTestimonial(db: Database, adminId: string, input: Testimonial, now: Date): Promise<void> {
  await requirePlatformAdmin(db, adminId);
  const quote = input.quote.trim();
  if (quote === '') {
    await asSystem(db, (trx) => trx.deleteFrom('platform_settings').where('key', '=', TESTIMONIAL_KEY).execute());
    return;
  }
  if (input.author.trim() === '' || !/^\d{4}-\d{2}-\d{2}$/.test(input.consentOn)) throw new RefusedError('temoignage_incomplet', 'Indiquez l’auteur et la date de l’accord écrit du client.');
  const value = JSON.stringify({ quote: quote.slice(0, 600), author: input.author.trim().slice(0, 120), role: input.role.trim().slice(0, 120), company: input.company.trim().slice(0, 120), consentOn: input.consentOn });
  await asSystem(db, (trx) =>
    trx
      .insertInto('platform_settings')
      .values({ key: TESTIMONIAL_KEY, value, updated_at: now, updated_by: adminId })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now, updated_by: adminId }))
      .execute(),
  );
}

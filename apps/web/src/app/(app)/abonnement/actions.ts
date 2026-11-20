'use server';

import {
  BillingError,
  ForbiddenError,
  NotFoundError,
  RefusedError,
  type SimulatedPortalAction,
  applySimulatedPortalAction,
  buyQuotaPack,
  completeSimulatedCheckout,
  openBillingPortal,
  setOveragePolicy,
  startSubscription,
} from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { appUrl, billing, billingSimulated, database } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pageOf = (workspaceId: string) => `${appUrl()}/abonnement/${workspaceId}`;

/** Exécute l'action ; renvoie l'adresse où aller (paiement Stripe, ou la page avec un message). */
async function run(workspaceId: string, action: (userId: string, now: Date) => Promise<string>): Promise<never> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let target: string;
  try {
    target = await action(userId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    const code = error instanceof ForbiddenError ? 'interdit' : error instanceof RefusedError ? error.code : error instanceof BillingError ? 'paiement-indisponible' : null;
    if (code === null) throw error;
    target = `/abonnement/${workspaceId}?message=${encodeURIComponent(code)}`;
  }
  revalidatePath(`/abonnement/${workspaceId}`);
  redirect(target);
}

function provider() {
  const p = billing();
  if (p === null) throw new RefusedError('paiement-non-configure', 'Paiement non configuré.');
  return p;
}

/** FAC-01, FAC-03 : souscrire (mensuel ou annuel) ; Stripe Checkout gère carte, SEPA, TVA et codes promo. */
export async function subscribeAction(workspaceId: string, form: FormData): Promise<void> {
  await run(workspaceId, (userId, now) =>
    startSubscription(
      database(),
      provider(),
      userId,
      workspaceId,
      { planKey: String(form.get('formule') ?? ''), interval: form.get('periodicite') === 'year' ? 'year' : 'month' },
      { success: `${pageOf(workspaceId)}?message=${billingSimulated() ? 'abonnement-paye' : 'paiement-en-cours'}`, cancel: `${pageOf(workspaceId)}?message=paiement-annule` },
      now,
    ),
  );
}

/** FAC-05 : portail de facturation (moyen de paiement, factures, changement de formule, résiliation). */
export async function portalAction(workspaceId: string): Promise<void> {
  await run(workspaceId, (userId) => openBillingPortal(database(), provider(), userId, workspaceId, `${pageOf(workspaceId)}?message=portail-retour`));
}

/** FAC-04 : au plafond, rédaction suspendue ou packs supplémentaires. */
export async function overageAction(workspaceId: string, form: FormData): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    await setOveragePolicy(database(), userId, workspaceId, form.get('depassement') === 'packs' ? 'packs' : 'suspend', now);
    return `/abonnement/${workspaceId}?message=depassement-enregistre`;
  });
}

/** FAC-04 : pack supplémentaire pour l'espace, sur le mois de quota en cours. */
export async function packAction(workspaceId: string, form: FormData): Promise<void> {
  await run(workspaceId, (userId) =>
    buyQuotaPack(database(), provider(), userId, workspaceId, String(form.get('pack') ?? ''), {
      success: `${pageOf(workspaceId)}?message=${billingSimulated() ? 'pack-paye' : 'paiement-en-cours'}`,
      cancel: `${pageOf(workspaceId)}?message=paiement-annule`,
    }),
  );
}

/** Retour vers une page de l'application seulement (pas de redirection ouverte). */
function safeReturn(raw: FormDataEntryValue | null): string {
  const value = String(raw ?? '');
  const base = `${appUrl()}/`;
  return value.startsWith(base) ? value.slice(appUrl().length) : '/';
}

const withMessage = (target: string, code: string) => {
  const url = new URL(target, appUrl());
  url.searchParams.set('message', code);
  return `${url.pathname}${url.search}`;
};

/** Paiement simulé (BILLING_MODE=fake) : « Payer » applique ce que Stripe enverrait. */
export async function simulateCheckoutAction(form: FormData): Promise<void> {
  if (!billingSimulated()) notFound();
  const userId = await requireUserId();
  const back = safeReturn(form.get('retour'));
  const text = (name: string) => String(form.get(name) ?? '');
  let target = back;
  try {
    await completeSimulatedCheckout(
      database(),
      userId,
      {
        mode: text('mode'),
        customerId: text('client'),
        priceId: text('prix'),
        quantity: Number.parseInt(text('quantite'), 10) || 1,
        orgId: text('org_id'),
        ...(text('workspace_id') && { workspaceId: text('workspace_id') }),
        ...(text('offer_key') && { offerKey: text('offer_key') }),
      },
      new Date(),
    );
  } catch (error) {
    if (error instanceof ForbiddenError) target = withMessage(back, 'interdit');
    else if (error instanceof RefusedError) target = withMessage(back, error.code);
    else throw error;
  }
  redirect(target);
}

const PORTAL_ACTIONS: readonly SimulatedPortalAction[] = ['resilier', 'reprendre', 'echec_paiement', 'paiement', 'fin_resiliation'];

/** Portail simulé : résiliation, reprise, échec ou réussite d'un prélèvement. */
export async function simulatePortalAction(form: FormData): Promise<void> {
  if (!billingSimulated()) notFound();
  const userId = await requireUserId();
  const back = safeReturn(form.get('retour'));
  const action = String(form.get('action') ?? '') as SimulatedPortalAction;
  let target = back;
  try {
    if (!PORTAL_ACTIONS.includes(action)) throw new RefusedError('choix_inconnu', 'Choix inconnu.');
    await applySimulatedPortalAction(database(), userId, String(form.get('client') ?? ''), action, new Date());
  } catch (error) {
    if (error instanceof ForbiddenError) target = withMessage(back, 'interdit');
    else if (error instanceof RefusedError) target = withMessage(back, error.code);
    else throw error;
  }
  redirect(target);
}

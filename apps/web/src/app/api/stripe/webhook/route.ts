/**
 * POST /api/stripe/webhook : événements Stripe (abonnement créé ou modifié, paiement réussi
 * ou en échec, pack payé). Signature vérifiée avec STRIPE_WEBHOOK_SECRET ; chaque événement
 * est appliqué une seule fois. Événements à activer côté Stripe :
 * checkout.session.completed, customer.subscription.created, customer.subscription.updated,
 * customer.subscription.deleted, invoice.paid, invoice.payment_failed.
 */
import { BillingError, applyBillingEvent, parseStripeEvent, verifyStripeSignature } from '@posts-auto/services';
import { database } from '../../../../server/context.ts';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 512 * 1024;

export async function POST(request: Request) {
  const secret = process.env['STRIPE_WEBHOOK_SECRET'];
  if (!secret) return Response.json({ error: 'Webhook non configuré' }, { status: 503 });
  const payload = await request.text();
  if (payload.length > MAX_BYTES) return Response.json({ error: 'Trop volumineux' }, { status: 413 });
  const now = new Date();
  try {
    verifyStripeSignature(payload, request.headers.get('stripe-signature'), secret, now);
  } catch (error) {
    if (error instanceof BillingError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'JSON invalide' }, { status: 400 });
  }
  const event = parseStripeEvent(raw);
  const applied = await applyBillingEvent(database(), event, now);
  return Response.json({ received: true, kind: event.kind, duplicate: !applied });
}

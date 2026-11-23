/**
 * POST /api/email-entrant/<INBOUND_EMAIL_WEBHOOK_SECRET> : e-mails reçus par Brevo (IDE-07).
 * Brevo ne signe pas ce webhook : le secret de l'adresse tient lieu d'authentification.
 */
import { handleInboundWebhook, inboundConfigFromEnv } from '@posts-auto/services';
import { database, mediaStore } from '../../../../server/context.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const { status, body } = await handleInboundWebhook(database(), mediaStore(), inboundConfigFromEnv(process.env), secret, await request.text(), new Date());
  return Response.json(body, { status });
}

/** Point de contrôle pour la supervision (NF-07) et le test de l'outillage. */
import { departureSentence } from '@posts-auto/core';

export const dynamic = 'force-dynamic';

export function GET() {
  const sample = departureSentence({ status: 'valide', scheduledAt: new Date(Date.now() + 86_400_000) }, new Date(), 'Europe/Paris');
  return Response.json({ ok: true, sample });
}

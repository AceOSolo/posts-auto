/**
 * Images des posts, servies seulement aux personnes qui voient le post (RLS) ;
 * jamais d'adresse publique (SEC-07 : URL privées).
 */
import { findMediaForUser } from '@posts-auto/services';
import { database, mediaStore } from '../../../server/context.ts';
import { logDeniedAccess } from '../../../server/security-log.ts';
import { currentUserId } from '../../../server/session.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const userId = await currentUserId();
  if (userId === null || !UUID.test(assetId)) return new Response('Introuvable', { status: 404 });
  const media = await findMediaForUser(database(), userId, assetId);
  if (media === null) {
    logDeniedAccess({ userId, resource: 'media', id: assetId });
    return new Response('Introuvable', { status: 404 });
  }
  const bytes = await mediaStore().read(media.storageKey);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': media.mime,
      'Cache-Control': 'private, max-age=3600',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}

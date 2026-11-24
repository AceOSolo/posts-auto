/**
 * VAL-06 : images du post sur la page ouverte depuis l'e-mail, sans connexion. Le lien de
 * validation fait foi : uniquement les images de ce post, tant que le lien est valable.
 */
import { approvalLinkMedia } from '@posts-auto/services';
import { database, mediaStore } from '../../../../../server/context.ts';

export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; assetId: string }> }) {
  const { token, assetId } = await params;
  if (!TOKEN.test(token) || !UUID.test(assetId)) return new Response('Introuvable', { status: 404 });
  const media = await approvalLinkMedia(database(), token, assetId, new Date());
  if (media === null) return new Response('Introuvable', { status: 404 });
  const bytes = await mediaStore().read(media.storageKey);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': media.mime,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

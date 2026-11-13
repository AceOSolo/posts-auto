/** Téléchargement de l'archive de mes données (RGPD, section 10.2 ; REC-12). */
import { exportUserData } from '@posts-auto/services';
import { database, mediaStore } from '../../../server/context.ts';
import { currentUserId } from '../../../server/session.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await currentUserId();
  if (userId === null) return new Response('Connexion requise', { status: 401 });
  const { archive, fileName } = await exportUserData(database(), mediaStore(), userId, new Date());
  return new Response(new Uint8Array(archive), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}

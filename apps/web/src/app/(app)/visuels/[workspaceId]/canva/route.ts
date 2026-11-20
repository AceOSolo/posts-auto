/** VIS-07 : départ vers Canva (OAuth avec PKCE), pour qui gère le contenu de l'espace. */
import { randomBytes } from 'node:crypto';
import { canManageContent, pkcePair, workspaceRole } from '@posts-auto/services';
import { asUser } from '@posts-auto/db';
import { cookies } from 'next/headers';
import { appUrl, canvaApi, database } from '../../../../../server/context.ts';
import { currentUserId } from '../../../../../server/session.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const userId = await currentUserId();
  if (userId === null || !UUID.test(workspaceId)) return new Response('Introuvable', { status: 404 });
  const allowed = await asUser(database(), userId, async (trx) => canManageContent(await workspaceRole(trx, userId, workspaceId)));
  if (!allowed) return new Response('Introuvable', { status: 404 });
  const api = canvaApi();
  if (api === null) return Response.redirect(`${appUrl()}/visuels/${workspaceId}?message=canva-non-configure#canva`, 303);
  const state = randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkcePair();
  (await cookies()).set('canva_oauth', Buffer.from(JSON.stringify({ state, verifier, workspaceId })).toString('base64url'), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/visuels',
    maxAge: 600,
  });
  return Response.redirect(api.authorizeUrl({ state, codeChallenge: challenge, redirectUri: `${appUrl()}/visuels/canva/retour` }), 303);
}

/** VIS-07 : retour de Canva ; l'état doit revenir à l'identique, la personne doit être celle du départ. */
import { ForbiddenError, NotFoundError, confirmCanvaConnection } from '@posts-auto/services';
import { CanvaError } from '@posts-auto/visuals';
import { cookies } from 'next/headers';
import { appUrl, canvaApi, database, tokenCipher } from '../../../../../server/context.ts';
import { currentUserId } from '../../../../../server/session.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const raw = jar.get('canva_oauth')?.value;
  jar.delete({ name: 'canva_oauth', path: '/visuels' });
  let saved: { state?: string; verifier?: string; workspaceId?: string } = {};
  try {
    saved = raw ? (JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as typeof saved) : {};
  } catch {
    saved = {};
  }
  const workspaceId = typeof saved.workspaceId === 'string' && UUID.test(saved.workspaceId) ? saved.workspaceId : null;
  if (workspaceId === null) return Response.redirect(`${appUrl()}/`, 303);
  const back = (message: string) => Response.redirect(`${appUrl()}/visuels/${workspaceId}?message=${message}#canva`, 303);
  const userId = await currentUserId();
  const api = canvaApi();
  const cipher = tokenCipher();
  const code = url.searchParams.get('code');
  if (userId === null || api === null || cipher === null) return back('canva-non-configure');
  if (code === null || !saved.verifier || url.searchParams.get('state') !== saved.state) return back('canva-expire');
  try {
    await confirmCanvaConnection(database(), api, cipher, userId, workspaceId, { code, codeVerifier: saved.verifier, redirectUri: `${appUrl()}/visuels/canva/retour` }, new Date());
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return back('interdit');
    if (error instanceof CanvaError || error instanceof Error) return back('canva-erreur');
    throw error;
  }
  return back('canva-connecte');
}

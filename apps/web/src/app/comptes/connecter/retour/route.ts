/**
 * Retour de LinkedIn après autorisation (LNK-01). Vérifie l'état anti-falsification, puis
 * enregistre le compte sous l'identité de la personne connectée.
 */
import { timingSafeEqual } from 'node:crypto';
import { LinkedInError } from '@posts-auto/linkedin';
import { NotFoundError, RefusedError, connectProfile } from '@posts-auto/services';
import { cookies, headers } from 'next/headers';
import { appUrl, database, linkedinOAuth, tokenCipher } from '../../../../server/context.ts';
import { OAUTH_COOKIE, decodeOAuthState } from '../../../../server/oauth-state.ts';
import { currentUserId } from '../../../../server/session.ts';

export const dynamic = 'force-dynamic';

function back(path: string, message: string): Response {
  return Response.redirect(`${appUrl()}${path}?message=${encodeURIComponent(message)}`, 303);
}

function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const jar = await cookies();
  const pending = decodeOAuthState(jar.get(OAUTH_COOKIE)?.value);
  jar.delete({ name: OAUTH_COOKIE, path: '/comptes/connecter' });

  const userId = await currentUserId();
  if (userId === null) return Response.redirect(`${appUrl()}/connexion`, 303);
  if (pending === null || !sameState(pending.state, params.get('state') ?? '')) return back('/', 'connexion-expiree');
  const accounts = `/comptes/${pending.workspaceId}`;
  // L'utilisateur a refusé sur LinkedIn (ex. error=user_cancelled_authorize).
  if (params.has('error')) return back(accounts, 'connexion-annulee');

  const oauth = linkedinOAuth();
  const cipher = tokenCipher();
  const code = params.get('code');
  if (oauth === null || cipher === null) return back(accounts, 'connexion-non-configuree');
  if (!code) return back(accounts, 'connexion-annulee');

  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim();
  try {
    const result = await connectProfile(
      database(),
      { oauth, cipher },
      { userId, workspaceId: pending.workspaceId, code, aiLearning: pending.aiLearning, ...(ip && /^[\d.:a-f]+$/i.test(ip) ? { ip } : {}) },
      new Date(),
    );
    return back(accounts, result.reconnected ? 'compte-reconnecte' : 'compte-connecte');
  } catch (error) {
    if (error instanceof NotFoundError) return back('/', 'interdit');
    if (error instanceof RefusedError) return back(accounts, error.code);
    if (error instanceof LinkedInError) return back(accounts, 'linkedin-erreur');
    throw error;
  }
}

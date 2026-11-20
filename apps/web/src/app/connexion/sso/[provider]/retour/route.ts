/**
 * ONB-01 : retour de Google ou Microsoft. L'état doit revenir à l'identique ; l'adresse
 * vérifiée doit être celle d'un compte existant. La double authentification suit (SEC-04).
 */
import { SsoError, completeSsoLogin } from '@posts-auto/services';
import { cookies, headers } from 'next/headers';
import { appUrl, database, ssoProviders } from '../../../../../server/context.ts';
import { SESSION_COOKIE } from '../../../../../server/session.ts';
import { SSO_COOKIE, SSO_COOKIE_PATH, decodeSsoState } from '../../../../../server/sso-state.ts';

export const dynamic = 'force-dynamic';

const back = (message: string) => Response.redirect(`${appUrl()}/connexion?message=${message}`, 303);

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: key } = await params;
  const url = new URL(request.url);
  const jar = await cookies();
  const saved = decodeSsoState(jar.get(SSO_COOKIE)?.value);
  jar.delete({ name: SSO_COOKIE, path: SSO_COOKIE_PATH });
  const provider = ssoProviders().find((p) => p.key === key);
  if (provider === undefined) return back('sso-non-configure');
  if (url.searchParams.get('error')) return back('sso-annule');
  const code = url.searchParams.get('code');
  if (saved === null || saved.provider !== provider.key || code === null || url.searchParams.get('state') !== saved.state) return back('sso-expire');

  let identity;
  try {
    identity = await provider.exchange({ code, codeVerifier: saved.verifier, redirectUri: `${appUrl()}/connexion/sso/${provider.key}/retour` });
  } catch (error) {
    if (error instanceof SsoError) return back('sso-erreur');
    throw error;
  }
  const h = await headers();
  const userAgent = h.get('user-agent') ?? undefined;
  const outcome = await completeSsoLogin(database(), identity, new Date(), userAgent === undefined ? {} : { userAgent });
  if (!outcome.ok) return back(outcome.reason === 'compte_inconnu' ? 'sso-compte-inconnu' : 'sso-adresse-non-verifiee');
  jar.set(SESSION_COOKIE, outcome.session.sessionToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: outcome.session.expiresAt });
  return Response.redirect(`${appUrl()}/`, 303);
}

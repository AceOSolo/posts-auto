/** ONB-01 : départ vers Google ou Microsoft (state et PKCE dans un cookie de 10 minutes). */
import { randomBytes } from 'node:crypto';
import { pkcePair } from '@posts-auto/services';
import { cookies } from 'next/headers';
import { appUrl, ssoProviders } from '../../../../server/context.ts';
import { SSO_COOKIE, SSO_COOKIE_PATH, encodeSsoState } from '../../../../server/sso-state.ts';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: key } = await params;
  const provider = ssoProviders().find((p) => p.key === key);
  if (provider === undefined) return Response.redirect(`${appUrl()}/connexion?message=sso-non-configure`, 303);
  const state = randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkcePair();
  (await cookies()).set(SSO_COOKIE, encodeSsoState({ provider: provider.key, state, verifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: SSO_COOKIE_PATH,
    maxAge: 600,
  });
  return Response.redirect(provider.authorizeUrl({ state, codeChallenge: challenge, redirectUri: `${appUrl()}/connexion/sso/${provider.key}/retour` }), 303);
}

'use server';

import { consumeLoginLink, endSupportSession, loginLinkMail, requestLoginLink, revokeSession } from '@posts-auto/services';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { appUrl, database, mailer } from '../../server/context.ts';
import { clearSessionCookie, sessionToken, setSessionCookie } from '../../server/session.ts';

async function clientIp(): Promise<string | undefined> {
  const forwarded = (await headers()).get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim();
  return ip && /^[\d.:a-f]+$/i.test(ip) ? ip : undefined;
}

/** Étape 1 : envoyer un lien. Même réponse que l'adresse soit connue ou non. */
export async function requestLink(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const result = await requestLoginLink(database(), email, new Date(), await clientIp());
  if (result.kind === 'rate_limited') redirect('/connexion?message=trop');
  if (result.kind === 'send') {
    const url = `${appUrl()}/connexion/lien?jeton=${encodeURIComponent(result.token)}`;
    await mailer().send({ to: { email: result.email }, ...loginLinkMail({ appUrl: appUrl(), recipientName: null }, url), tag: 'connexion' });
  }
  redirect('/connexion?message=envoye');
}

/** Étape 2 : le clic sur « Se connecter » consomme le lien et ouvre la session. */
export async function confirmLogin(formData: FormData): Promise<void> {
  const token = String(formData.get('jeton') ?? '');
  const ip = await clientIp();
  const userAgent = (await headers()).get('user-agent') ?? undefined;
  const outcome = await consumeLoginLink(database(), token, new Date(), {
    ...(ip === undefined ? {} : { ip }),
    ...(userAgent === undefined ? {} : { userAgent }),
  });
  if (!outcome.ok) redirect('/connexion?message=lien');
  await setSessionCookie(outcome.session.sessionToken, outcome.session.expiresAt);
  redirect('/');
}

export async function logout(): Promise<void> {
  const token = await sessionToken();
  // ADM-02 : la fin d'une session du support est inscrite au journal du client.
  if (token !== undefined) await endSupportSession(database(), token, new Date());
  if (token !== undefined) await revokeSession(database(), token, new Date());
  await clearSessionCookie();
  redirect('/connexion');
}

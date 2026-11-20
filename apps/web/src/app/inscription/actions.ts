'use server';

import { confirmSignup, loginLinkMail, requestSignup, signupMail } from '@posts-auto/services';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { appUrl, database, mailer } from '../../server/context.ts';
import { setSessionCookie } from '../../server/session.ts';

async function clientIp(): Promise<string | undefined> {
  const forwarded = (await headers()).get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim();
  return ip && /^[\d.:a-f]+$/i.test(ip) ? ip : undefined;
}

/**
 * ONB-01 : demande d'inscription. Même message affiché que l'adresse soit nouvelle (lien de
 * confirmation) ou déjà inscrite (lien de connexion).
 */
export async function requestSignupAction(formData: FormData): Promise<void> {
  const text = (name: string) => String(formData.get(name) ?? '');
  const result = await requestSignup(
    database(),
    { email: text('email'), fullName: text('nom'), orgName: text('organisation'), orgKind: text('type') },
    new Date(),
    await clientIp(),
  );
  if (result.kind === 'invalid') redirect(`/inscription?message=inscription_${result.field}`);
  if (result.kind === 'rate_limited') redirect('/inscription?message=trop');
  if (result.kind === 'confirm') {
    const url = `${appUrl()}/inscription/confirmer?jeton=${encodeURIComponent(result.token)}`;
    await mailer().send({ to: { email: result.email, name: result.fullName }, ...signupMail({ appUrl: appUrl(), recipientName: result.fullName }, url), tag: 'inscription' });
  } else {
    const url = `${appUrl()}/connexion/lien?jeton=${encodeURIComponent(result.token)}`;
    await mailer().send({ to: { email: result.email }, ...loginLinkMail({ appUrl: appUrl(), recipientName: null }, url), tag: 'connexion' });
  }
  redirect('/inscription?message=inscription-envoyee');
}

/** ONB-02 : le clic sur « Créer mon espace » crée l'organisation et ouvre la session. */
export async function confirmSignupAction(formData: FormData): Promise<void> {
  const token = String(formData.get('jeton') ?? '');
  const ip = await clientIp();
  const userAgent = (await headers()).get('user-agent') ?? undefined;
  const outcome = await confirmSignup(database(), token, new Date(), { ...(ip !== undefined && { ip }), ...(userAgent !== undefined && { userAgent }) });
  if (!outcome.ok) redirect('/inscription?message=inscription_lien');
  await setSessionCookie(outcome.session.sessionToken, outcome.session.expiresAt);
  redirect(outcome.created ? `/demarrage/${outcome.workspaceId}` : '/');
}

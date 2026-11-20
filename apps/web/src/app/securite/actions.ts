'use server';

import { RefusedError, confirmTotpSetup, disableTotp, startTotpSetup, verifySessionMfa } from '@posts-auto/services';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { database, tokenCipher } from '../../server/context.ts';
import { RECOVERY_COOKIE } from '../../server/mfa.ts';
import { clearSessionCookie, currentSession, requireUserId, sessionToken } from '../../server/session.ts';

const PRODUCTION = process.env.NODE_ENV === 'production';

function cipherOrFail() {
  const cipher = tokenCipher();
  if (cipher === null) redirect('/securite?message=chiffrement-non-configure');
  return cipher;
}

/** Affiche le code à scanner (nouveau secret). */
export async function startSetupAction(): Promise<void> {
  const userId = await requireUserId({ allowMfaSetup: true });
  try {
    await startTotpSetup(database(), cipherOrFail(), userId, new Date());
  } catch (error) {
    if (error instanceof RefusedError) redirect(`/securite?message=${encodeURIComponent(error.code)}`);
    throw error;
  }
  redirect('/securite#mise-en-place');
}

/** Premier code : active la double authentification et montre les codes de secours. */
export async function confirmSetupAction(form: FormData): Promise<void> {
  const userId = await requireUserId({ allowMfaSetup: true });
  const session = await currentSession();
  const cipher = cipherOrFail();
  let codes: string[];
  try {
    codes = await confirmTotpSetup(database(), cipher, userId, session?.sessionId ?? '', String(form.get('code') ?? ''), new Date());
  } catch (error) {
    if (error instanceof RefusedError) redirect(`/securite?message=${encodeURIComponent(error.code)}#mise-en-place`);
    throw error;
  }
  (await cookies()).set(RECOVERY_COOKIE, Buffer.from(cipher.encrypt(codes.join(' '), `recovery:${userId}`)).toString('base64url'), {
    httpOnly: true,
    secure: PRODUCTION,
    sameSite: 'strict',
    path: '/securite',
    maxAge: 600,
  });
  redirect('/securite?message=mfa-activee');
}

/** « J'ai noté mes codes » : ils ne sont plus affichés. */
export async function hideRecoveryCodesAction(): Promise<void> {
  await requireUserId({ allowMfaSetup: true });
  (await cookies()).delete({ name: RECOVERY_COOKIE, path: '/securite' });
  redirect('/securite');
}

export async function disableAction(form: FormData): Promise<void> {
  const userId = await requireUserId({ allowMfaSetup: true });
  try {
    await disableTotp(database(), cipherOrFail(), userId, String(form.get('code') ?? ''), new Date());
  } catch (error) {
    if (error instanceof RefusedError) redirect(`/securite?message=${encodeURIComponent(error.code)}`);
    throw error;
  }
  redirect('/securite?message=mfa-desactivee');
}

/** Code saisi après la connexion par lien. */
export async function verifyCodeAction(form: FormData): Promise<void> {
  const token = await sessionToken();
  if (token === undefined) redirect('/connexion');
  const outcome = await verifySessionMfa(database(), cipherOrFail(), token, String(form.get('code') ?? ''), new Date());
  if (outcome === 'ok') redirect('/');
  if (outcome === 'revoked') {
    await clearSessionCookie();
    redirect('/connexion?message=code-trop-essais');
  }
  redirect('/connexion/code?message=code_faux');
}

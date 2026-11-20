'use server';

import { randomBytes } from 'node:crypto';
import { PAGE_SCOPES, PROFILE_SCOPES } from '@posts-auto/linkedin';
import { ForbiddenError, NotFoundError, RefusedError, confirmPageConnection, disconnectAccount } from '@posts-auto/services';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { database, linkedinOAuth, tokenCipher } from '../../../server/context.ts';
import { OAUTH_COOKIE, type OAuthState, encodeOAuthState } from '../../../server/oauth-state.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** LNK-01 : après le consentement (LNK-09), envoi vers LinkedIn. */
export async function startConnection(workspaceId: string, formData: FormData): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  await requireUserId();
  if (formData.get('accord') !== 'oui') redirect(`/comptes/${workspaceId}/connecter?message=consentement-requis`);
  const oauth = linkedinOAuth();
  if (oauth === null || tokenCipher() === null) redirect(`/comptes/${workspaceId}?message=connexion-non-configuree`);

  const state = randomBytes(24).toString('base64url');
  await setOAuthCookie({ state, workspaceId, aiLearning: formData.get('apprentissage') === 'oui', mode: 'profile' });
  redirect(oauth.authorizationUrl(state, PROFILE_SCOPES));
}

async function setOAuthCookie(value: OAuthState): Promise<void> {
  (await cookies()).set(OAUTH_COOKIE, encodeOAuthState(value), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // « lax » : le cookie accompagne le retour de LinkedIn, qui est une navigation de premier niveau.
    sameSite: 'lax',
    path: '/comptes/connecter',
    maxAge: 10 * 60,
  });
}

/** LNK-02 : connexion des pages d'entreprise administrées par la personne. */
export async function startPagesConnection(workspaceId: string): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  await requireUserId();
  const oauth = linkedinOAuth();
  if (oauth === null || tokenCipher() === null) redirect(`/comptes/${workspaceId}?message=connexion-non-configuree`);
  const state = randomBytes(24).toString('base64url');
  await setOAuthCookie({ state, workspaceId, aiLearning: false, mode: 'pages' });
  redirect(oauth.authorizationUrl(state, PAGE_SCOPES));
}

/** LNK-02 : pages cochées, ajoutées à l'espace. */
export async function confirmPagesAction(workspaceId: string, pendingId: string, formData: FormData): Promise<void> {
  if (!UUID.test(workspaceId) || !UUID.test(pendingId)) notFound();
  const userId = await requireUserId();
  const cipher = tokenCipher();
  if (cipher === null) redirect(`/comptes/${workspaceId}?message=connexion-non-configuree`);
  const urns = formData.getAll('pages').map(String);
  let message: string;
  try {
    const count = await confirmPageConnection(database(), cipher, { userId, workspaceId, pendingId, urns }, new Date());
    message = count > 1 ? 'pages-connectees' : 'page-connectee';
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) message = 'interdit';
    else if (error instanceof RefusedError) {
      if (error.code === 'aucune_page_choisie') redirect(`/comptes/${workspaceId}/pages?attente=${pendingId}&message=aucune_page_choisie`);
      message = error.code;
    } else throw error;
  }
  redirect(`/comptes/${workspaceId}?message=${message}`);
}

/** LNK-05 : déconnexion d'un compte. */
export async function disconnectAction(workspaceId: string, accountId: string): Promise<void> {
  if (!UUID.test(workspaceId) || !UUID.test(accountId)) notFound();
  const userId = await requireUserId();
  let message = 'compte-deconnecte';
  try {
    await disconnectAccount(database(), userId, accountId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) message = 'interdit';
    else throw error;
  }
  redirect(`/comptes/${workspaceId}?message=${message}`);
}

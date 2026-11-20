/**
 * Session de la personne connectée (SEC-03) : jeton dans un cookie HttpOnly, empreinte en
 * base. En production, le préfixe « __Host- » garantit un cookie sécurisé, limité à ce domaine.
 */
import { type ActiveSession, mfaStatus, resolveSession } from '@posts-auto/services';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { database } from './context.ts';

const PRODUCTION = process.env.NODE_ENV === 'production';
export const SESSION_COOKIE = PRODUCTION ? '__Host-session' : 'session';

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Session telle qu'elle est, second facteur en attente compris (pages de connexion). */
export async function currentSession(): Promise<ActiveSession | null> {
  const token = await sessionToken();
  if (token === undefined) return null;
  return resolveSession(database(), token, new Date());
}

/** Personne connectée ; null tant que le code de double authentification n'est pas saisi (SEC-04). */
export async function currentUserId(): Promise<string | null> {
  const session = await currentSession();
  return session === null || session.mfaPending ? null : session.userId;
}

/**
 * Page ou action réservée aux personnes connectées. SEC-04 : code à saisir après le lien ;
 * propriétaire ou administrateur sans double authentification après le délai : mise en place
 * d'abord (sauf sur la page de mise en place elle-même).
 */
export async function requireUserId(options: { readonly allowMfaSetup?: boolean } = {}): Promise<string> {
  const session = await currentSession();
  if (session === null) redirect('/connexion');
  if (session.mfaPending) redirect('/connexion/code');
  if (!options.allowMfaSetup && (await mfaStatus(database(), session.userId, new Date())).overdue) redirect('/securite?message=mfa-obligatoire');
  return session.userId;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: PRODUCTION,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

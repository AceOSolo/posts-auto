/**
 * Session de la personne connectée (SEC-03) : jeton dans un cookie HttpOnly, empreinte en
 * base. En production, le préfixe « __Host- » garantit un cookie sécurisé, limité à ce domaine.
 */
import { resolveSession } from '@posts-auto/services';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { database } from './context.ts';

const PRODUCTION = process.env.NODE_ENV === 'production';
export const SESSION_COOKIE = PRODUCTION ? '__Host-session' : 'session';

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function currentUserId(): Promise<string | null> {
  const token = await sessionToken();
  if (token === undefined) return null;
  const session = await resolveSession(database(), token, new Date());
  return session?.userId ?? null;
}

/** Page ou action réservée aux personnes connectées. */
export async function requireUserId(): Promise<string> {
  const userId = await currentUserId();
  if (userId === null) redirect('/connexion');
  return userId;
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

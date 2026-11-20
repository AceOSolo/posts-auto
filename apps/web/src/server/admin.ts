/** Back-office (ADM) : réservé à l'éditeur, double authentification active. */
import { ForbiddenError, RefusedError, requirePlatformAdmin } from '@posts-auto/services';
import { notFound, redirect } from 'next/navigation';
import { database } from './context.ts';
import { requireUserId } from './session.ts';

export async function requireAdmin(): Promise<string> {
  const userId = await requireUserId();
  try {
    await requirePlatformAdmin(database(), userId);
  } catch (error) {
    // Introuvable pour qui n'est pas de l'éditeur : l'existence du back-office n'est pas révélée.
    if (error instanceof ForbiddenError) notFound();
    if (error instanceof RefusedError) redirect(`/securite?message=${encodeURIComponent(error.code)}`);
    throw error;
  }
  return userId;
}

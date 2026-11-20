'use server';

import { ForbiddenError, NotFoundError, RefusedError, saveCompanyInfo, setOnboardingClosed } from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(workspaceId: string, back: string, action: (userId: string, now: Date) => Promise<string>): Promise<never> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let message: string;
  try {
    message = await action(userId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) message = 'interdit';
    else if (error instanceof RefusedError) message = error.code;
    else throw error;
  }
  revalidatePath(`/demarrage/${workspaceId}`);
  redirect(`${back}${back.includes('?') ? '&' : '?'}message=${encodeURIComponent(message)}`);
}

/** ONB-03, étape 1 : l'entreprise. */
export async function saveCompanyAction(workspaceId: string, form: FormData): Promise<void> {
  const text = (name: string) => String(form.get(name) ?? '');
  await run(workspaceId, `/demarrage/${workspaceId}`, async (userId, now) => {
    await saveCompanyInfo(database(), userId, workspaceId, { name: text('nom'), website: text('site'), sector: text('secteur'), size: text('taille') }, now);
    return 'entreprise-enregistree';
  });
}

/** Termine ou ferme l'assistant ; il reste accessible à son adresse. */
export async function closeOnboardingAction(workspaceId: string, closed: boolean): Promise<void> {
  await run(workspaceId, closed ? '/' : `/demarrage/${workspaceId}`, async (userId, now) => {
    await setOnboardingClosed(database(), userId, workspaceId, closed, now);
    return closed ? 'demarrage-ferme' : 'demarrage-rouvert';
  });
}

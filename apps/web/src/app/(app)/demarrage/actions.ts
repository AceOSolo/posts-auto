'use server';

import { ModelError } from '@posts-auto/ai';
import { randomUUID } from 'node:crypto';
import { ForbiddenError, NotFoundError, RefusedError, proposeEditorialLineFor, saveCompanyInfo, setOnboardingClosed, writeSamplePostFor } from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database, mediaStore, model, usdToEur } from '../../../server/context.ts';
import { editorialProposalKey } from '../../../server/drafts.ts';
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

/**
 * Configuration rapide : enregistre l'entreprise, puis l'IA propose la ligne éditoriale à partir
 * du site. La proposition reste à relire et à valider (ONB-04) : rien d'autre n'est enregistré.
 */
export async function quickStartAction(workspaceId: string, form: FormData): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const text = (name: string) => String(form.get(name) ?? '');
  const now = new Date();
  let destination: string;
  let companySaved = false;
  try {
    await saveCompanyInfo(database(), userId, workspaceId, { name: text('nom'), website: text('site'), sector: text('secteur'), size: text('taille') }, now);
    companySaved = true;
    const proposal = await proposeEditorialLineFor(database(), model(), userId, workspaceId, {}, now, { usdToEur: usdToEur() });
    const id = randomUUID();
    await mediaStore().write(editorialProposalKey(workspaceId, id), new TextEncoder().encode(JSON.stringify(proposal)));
    destination = `/ligne/${workspaceId}?proposition=${id}&depuis=demarrage#ligne`;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    const code = error instanceof ForbiddenError ? 'interdit' : error instanceof RefusedError ? error.code : error instanceof ModelError ? 'ia-indisponible' : null;
    if (code === null) throw error;
    // Entreprise enregistrée mais site illisible ou IA absente : on poursuit sur la ligne éditoriale.
    destination = companySaved ? `/ligne/${workspaceId}?message=${encodeURIComponent(code)}#proposer` : `/demarrage/${workspaceId}?mode=rapide&message=${encodeURIComponent(code)}`;
  }
  revalidatePath(`/demarrage/${workspaceId}`);
  redirect(destination);
}

/** Termine ou ferme l'assistant ; il reste accessible à son adresse. */
export async function closeOnboardingAction(workspaceId: string, closed: boolean): Promise<void> {
  await run(workspaceId, closed ? '/' : `/demarrage/${workspaceId}`, async (userId, now) => {
    await setOnboardingClosed(database(), userId, workspaceId, closed, now);
    return closed ? 'demarrage-ferme' : 'demarrage-rouvert';
  });
}

/** Post d'exemple rédigé par l'IA à partir du site de l'entreprise (jamais publié). */
export async function samplePostAction(workspaceId: string): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let message = 'exemple-redige';
  try {
    await writeSamplePostFor(database(), model(), userId, workspaceId, new Date(), { usdToEur: usdToEur() });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    const code = error instanceof ForbiddenError ? 'interdit' : error instanceof RefusedError ? error.code : error instanceof ModelError ? 'ia-indisponible' : null;
    if (code === null) throw error;
    message = code;
  }
  revalidatePath(`/demarrage/${workspaceId}`);
  redirect(`/demarrage/${workspaceId}?message=${encodeURIComponent(message)}#exemple`);
}

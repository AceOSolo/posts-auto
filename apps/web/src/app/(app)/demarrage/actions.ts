'use server';

import { ModelError } from '@posts-auto/ai';
import { randomUUID } from 'node:crypto';
import {
  ForbiddenError,
  NotFoundError,
  ONBOARDING_STEP_KEYS,
  type OnboardingStepKey,
  RefusedError,
  applySuggestedSlots,
  launchFirstGeneration,
  proposeEditorialLineFor,
  saveCompanyInfo,
  setOnboardingClosed,
  writeSamplePostFor,
} from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { database, mediaStore, model, usdToEur } from '../../../server/context.ts';
import { editorialProposalKey } from '../../../server/drafts.ts';
import { requireUserId } from '../../../server/session.ts';
import { STEP_COOKIE, STEP_COOKIE_MAX_AGE, encodeStepCookie } from './step-cookie.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(workspaceId: string, back: string, action: (userId: string, now: Date) => Promise<string | null>): Promise<never> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let message: string | null;
  try {
    message = await action(userId, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) message = 'interdit';
    else if (error instanceof RefusedError) message = error.code;
    else throw error;
  }
  revalidatePath(`/demarrage/${workspaceId}`);
  if (message === null) redirect(back);
  redirect(`${back}${back.includes('?') ? '&' : '?'}message=${encodeURIComponent(message)}`);
}

async function rememberStep(workspaceId: string, step: OnboardingStepKey): Promise<void> {
  (await cookies()).set(STEP_COOKIE, encodeStepCookie(workspaceId, step), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: STEP_COOKIE_MAX_AGE,
  });
}

/** Pages où une étape se poursuit ; la cible vient d'une liste fermée, jamais d'une adresse reçue. */
function stepTarget(workspaceId: string, target: string): string | null {
  const fixed: Record<string, string> = {
    profil: `/comptes/${workspaceId}/connecter`,
    comptes: `/comptes/${workspaceId}`,
    ligne: `/ligne/${workspaceId}#proposer`,
    validateurs: `/espace/${workspaceId}`,
    charte: `/visuels/${workspaceId}#proposer-charte`,
    import: `/planning/${workspaceId}/import?depuis=demarrage`,
    redaction: `/planning/${workspaceId}/redactions`,
  };
  if (target in fixed) return fixed[target] ?? null;
  const account = /^fiche:(.+)$/.exec(target)?.[1];
  return account !== undefined && UUID.test(account) ? `/comptes/${workspaceId}/fiche/${account}` : null;
}

/** Part faire une étape sur sa page, en gardant le fil du démarrage. */
export async function openStepAction(workspaceId: string, step: string, target: string): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  await requireUserId();
  const key = ONBOARDING_STEP_KEYS.find((candidate) => candidate === step);
  const destination = stepTarget(workspaceId, target);
  if (key === undefined || destination === null) notFound();
  await rememberStep(workspaceId, key);
  redirect(destination);
}

/** Étape 1 : l'entreprise ; on passe ensuite à l'étape suivante. */
export async function saveCompanyAction(workspaceId: string, form: FormData): Promise<void> {
  const text = (name: string) => String(form.get(name) ?? '');
  await run(workspaceId, `/demarrage/${workspaceId}`, async (userId, now) => {
    await saveCompanyInfo(database(), userId, workspaceId, { name: text('nom'), website: text('site'), sector: text('secteur'), size: text('taille') }, now);
    return 'entreprise-enregistree';
  });
}

/**
 * Étape 3 : l'IA propose la ligne éditoriale à partir du site. La proposition reste à relire
 * et à valider (ONB-04) : rien n'est enregistré ici.
 */
export async function prepareLineAction(workspaceId: string): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let destination: string;
  try {
    const proposal = await proposeEditorialLineFor(database(), model(), userId, workspaceId, {}, new Date(), { usdToEur: usdToEur() });
    const id = randomUUID();
    await mediaStore().write(editorialProposalKey(workspaceId, id), new TextEncoder().encode(JSON.stringify(proposal)));
    await rememberStep(workspaceId, 'ligne');
    destination = `/ligne/${workspaceId}?proposition=${id}&depuis=demarrage#ligne`;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    const code = error instanceof ForbiddenError ? 'interdit' : error instanceof RefusedError ? error.code : error instanceof ModelError ? 'ia-indisponible' : null;
    if (code === null) throw error;
    destination = `/demarrage/${workspaceId}?etape=ligne&message=${encodeURIComponent(code)}`;
  }
  redirect(destination);
}

/** Étape 4 : créneaux conseillés pour les comptes qui n'en ont pas. */
export async function applySlotsAction(workspaceId: string): Promise<void> {
  await run(workspaceId, `/demarrage/${workspaceId}`, async (userId, now) => {
    await applySuggestedSlots(database(), userId, workspaceId, now);
    return null;
  });
}

/** Étape 5 : première rédaction, puis celle de chaque semaine pour un nouvel espace. */
export async function launchFirstRunAction(workspaceId: string): Promise<void> {
  await run(workspaceId, `/demarrage/${workspaceId}`, async (userId, now) => {
    await launchFirstGeneration(database(), userId, workspaceId, now);
    return 'redaction-demandee';
  });
}

/** Termine ou ferme l'assistant ; il reste accessible à son adresse. */
export async function closeOnboardingAction(workspaceId: string, closed: boolean): Promise<void> {
  if (closed) (await cookies()).delete(STEP_COOKIE);
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

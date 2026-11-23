import { NotFoundError, getOnboarding } from '@posts-auto/services';
import { cookies } from 'next/headers';
import { database } from '../../../server/context.ts';
import { currentUserId } from '../../../server/session.ts';
import { ReturnBarView } from './return-bar-view.tsx';
import { STEP_COOKIE, parseStepCookie } from './step-cookie.ts';

/**
 * Sur la page où se fait une étape, dit où l'on en est et ramène à la suite du démarrage.
 * Ne s'affiche que si la personne est partie du démarrage et qu'il reste une étape à faire.
 */
export async function OnboardingReturnBar() {
  const origin = parseStepCookie((await cookies()).get(STEP_COOKIE)?.value);
  if (origin === null) return null;
  const userId = await currentUserId();
  if (userId === null) return null;
  let onboarding;
  try {
    onboarding = await getOnboarding(database(), userId, origin.workspaceId);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  if (onboarding.closed || onboarding.current === null) return null;
  const index = onboarding.steps.findIndex((step) => step.key === origin.step);
  const step = onboarding.steps[index];
  if (step === undefined) return null;
  const total = onboarding.steps.length;
  return (
    <ReturnBarView
      href={`/demarrage/${origin.workspaceId}`}
      done={step.done}
      label={step.done ? `${step.title} : c’est fait.` : `Démarrage · étape ${index + 1} sur ${total} : ${step.title}`}
      cta={step.done ? 'Passer à l’étape suivante' : 'Revenir aux étapes'}
    />
  );
}

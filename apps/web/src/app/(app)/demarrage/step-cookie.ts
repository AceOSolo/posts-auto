import { ONBOARDING_STEP_KEYS, type OnboardingStepKey } from '@posts-auto/services';

/**
 * Étape du démarrage en cours quand la personne part la faire sur une autre page (comptes,
 * ligne éditoriale…) : la barre de retour la ramène ensuite à la suite du parcours.
 */
export const STEP_COOKIE = 'rostra_demarrage';
export const STEP_COOKIE_MAX_AGE = 24 * 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeStepCookie(workspaceId: string, step: OnboardingStepKey): string {
  return `${workspaceId}.${step}`;
}

export function parseStepCookie(value: string | undefined): { workspaceId: string; step: OnboardingStepKey } | null {
  if (value === undefined) return null;
  const [workspaceId, step, ...rest] = value.split('.');
  if (rest.length > 0 || workspaceId === undefined || !UUID.test(workspaceId)) return null;
  const key = ONBOARDING_STEP_KEYS.find((candidate) => candidate === step);
  return key === undefined ? null : { workspaceId, step: key };
}

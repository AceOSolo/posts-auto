'use server';

import { DEFAULT_WORKSPACE_CALENDAR, REFUSAL_REASONS, type RefusalReason, atLocal } from '@posts-auto/core';
import {
  type Decision,
  ForbiddenError,
  NotFoundError,
  RefusedError,
  decidePost,
  editPostText,
  getPostDetail,
  reschedulePost,
  retryPublication,
  withdrawPost,
} from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Retour après l'action : la liste « Mes posts » ou le détail du post (jamais une adresse libre). */
function destination(postId: string, formData: FormData, message: string): string {
  const base = formData.get('retour') === 'liste' ? '/' : `/posts/${postId}`;
  return `${base}?message=${encodeURIComponent(message)}`;
}

/**
 * Exécute l'action, puis redirige avec un code de message. Les erreurs métier deviennent
 * un message ; « introuvable » devient une page 404 (REC-01).
 */
async function run(postId: string, formData: FormData, action: (userId: string, now: Date) => Promise<string>): Promise<never> {
  if (!UUID.test(postId)) notFound();
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
  revalidatePath('/');
  redirect(destination(postId, formData, message));
}

export async function validateAction(postId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    const outcome = await decidePost(database(), userId, postId, { type: 'validate' }, now);
    return outcome.departsNow ? 'valide-maintenant' : 'valide';
  });
}

export async function requestChangesAction(postId: string, formData: FormData): Promise<void> {
  const note = String(formData.get('note') ?? '');
  await run(postId, formData, async (userId, now) => {
    await decidePost(database(), userId, postId, { type: 'requestChanges', note }, now);
    return 'modif';
  });
}

export async function refuseAction(postId: string, formData: FormData): Promise<void> {
  const reason = String(formData.get('motif') ?? '');
  const details = String(formData.get('precision') ?? '').trim();
  await run(postId, formData, async (userId, now) => {
    if (!(reason in REFUSAL_REASONS)) throw new RefusedError('details_required', 'Motif inconnu');
    const decision: Decision = {
      type: 'refuse',
      reason: reason as RefusalReason,
      ...(details === '' ? {} : { details }),
    };
    await decidePost(database(), userId, postId, decision, now);
    return 'refuse';
  });
}

export async function editTextAction(postId: string, formData: FormData): Promise<void> {
  // Les navigateurs envoient des fins de ligne CRLF : on les normalise.
  const body = String(formData.get('texte') ?? '').replace(/\r\n/g, '\n');
  await run(postId, formData, async (userId, now) => {
    const outcome = await editPostText(database(), userId, postId, body, now);
    return outcome.status === 'a_valider' && formData.get('statut') === 'valide' ? 'corrige-a-valider' : 'corrige';
  });
}

export async function rescheduleAction(postId: string, formData: FormData): Promise<void> {
  const value = String(formData.get('creneau') ?? '');
  await run(postId, formData, async (userId, now) => {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
    if (match === null) return 'date_invalide';
    // L'heure saisie est l'heure locale de l'espace du post.
    const { timeZone } = await getPostDetail(database(), userId, postId, now);
    let at: Date | null;
    try {
      at = atLocal(match[1] as string, match[2] as string, { ...DEFAULT_WORKSPACE_CALENDAR, timeZone });
    } catch {
      return 'date_invalide'; // ex. 30 février
    }
    if (at === null) return 'date_invalide'; // heure inexistante (passage à l'heure d'été)
    const outcome = await reschedulePost(database(), userId, postId, at, now);
    return outcome.outsideAllowedHours ? 'replanifie-hors-plage' : 'replanifie';
  });
}

export async function withdrawAction(postId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    await withdrawPost(database(), userId, postId, now);
    return 'retire';
  });
}

export async function retryAction(postId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    await retryPublication(database(), userId, postId, now);
    return 'reessai';
  });
}

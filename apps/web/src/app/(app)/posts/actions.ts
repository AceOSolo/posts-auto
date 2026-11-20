'use server';

import { DEFAULT_WORKSPACE_CALENDAR, REFUSAL_REASONS, type RefusalReason, atLocal } from '@posts-auto/core';
import { type AssistKind, ModelError } from '@posts-auto/ai';
import {
  addPostPhotos,
  applyHook,
  assistPost,
  decidePost,
  type Decision,
  editPostText,
  escapeHtml,
  ForbiddenError,
  getPostDetail,
  movePostPhoto,
  NotFoundError,
  type PhotoMode,
  proposeHooks,
  RefusedError,
  removePostPhoto,
  reportContent,
  requestVisualRedo,
  reschedulePost,
  retryPublication,
  makeCarousel,
  resolvePageMention,
  setFirstComment,
  setManualPostUrl,
  withdrawPost,
} from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { appUrl, database, linkedinPages, mailer, mediaStore, model, tokenCipher, usdToEur } from '../../../server/context.ts';
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

/** VIS-13, REC-11 : ajout de photos depuis le téléphone ou l'ordinateur. */
export async function addPhotosAction(postId: string, formData: FormData): Promise<void> {
  const files = formData.getAll('photos').filter((value): value is File => value instanceof File && value.size > 0);
  await run(postId, formData, async (userId, now) => {
    const photos = await Promise.all(files.map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type })));
    await addPostPhotos(database(), mediaStore(), userId, postId, photos, now);
    return 'photos-ajoutees';
  });
}

export async function removePhotoAction(postId: string, assetId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    if (!UUID.test(assetId)) throw new NotFoundError('Photo');
    await removePostPhoto(database(), userId, postId, assetId, now);
    return 'photo-retiree';
  });
}

export async function movePhotoAction(postId: string, assetId: string, direction: 'up' | 'down', formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    if (!UUID.test(assetId)) throw new NotFoundError('Photo');
    await movePostPhoto(database(), userId, postId, assetId, direction, now);
    return 'photos-reordonnees';
  });
}

/** VIS-13 : refaire le visuel avec une consigne (ou en ajouter un) ; préparé par le worker. */
export async function redoVisualAction(postId: string, formData: FormData): Promise<void> {
  const instruction = String(formData.get('consigne') ?? '');
  const photoMode = String(formData.get('photo') ?? '') as PhotoMode;
  await run(postId, formData, async (userId, now) => {
    await requestVisualRedo(database(), userId, postId, { instruction, photoMode }, now);
    return 'visuel-demande';
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

/**
 * GEN-12 : « Signaler un contenu ». Le signalement est enregistré, et l'éditeur du produit
 * est prévenu à l'adresse SUPPORT_EMAIL (sans elle, l'e-mail s'affiche dans la console).
 */
export async function reportContentAction(postId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    const reason = String(formData.get('motif') ?? '');
    const receipt = await reportContent(database(), userId, postId, reason, now);
    const support = process.env['SUPPORT_EMAIL'] ?? 'support@exemple.invalid';
    const text = [
      `Signalement n° ${receipt.reportId}`,
      `Espace : ${receipt.workspaceName} — compte : ${receipt.accountName}`,
      `Signalé par : ${receipt.reporterEmail}`,
      `Motif : ${reason.trim()}`,
      `Post : ${appUrl()}/posts/${postId}`,
    ].join('\n');
    await mailer().send({ to: { email: support }, subject: `Signalement d’un contenu (${receipt.workspaceName})`, text, html: `<pre>${escapeHtml(text)}</pre>`, tag: 'signalement' });
    return 'contenu-signale';
  });
}

/** GEN-08 : retouche du texte par l'IA (raccourcir, changer de ton, régénérer). */
export async function assistAction(postId: string, kind: AssistKind, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    try {
      const result = await assistPost(database(), model(), userId, postId, kind, now, usdToEur());
      return result.remaining.length > 0 ? 'retouche-a-verifier' : 'retouche-faite';
    } catch (error) {
      if (error instanceof ModelError) return 'ia-indisponible';
      throw error;
    }
  });
}

/** GEN-08 : trois accroches proposées, affichées sur la page du post. */
export async function hooksAction(postId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    try {
      await proposeHooks(database(), model(), userId, postId, now, usdToEur());
      return 'accroches-proposees';
    } catch (error) {
      if (error instanceof ModelError) return 'ia-indisponible';
      throw error;
    }
  });
}

export async function applyHookAction(postId: string, index: number, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    await applyHook(database(), userId, postId, index, now);
    return 'accroche-utilisee';
  });
}

/** PUB-09 : lien du post publié à la main. */
export async function setManualUrlAction(postId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    await setManualPostUrl(database(), userId, postId, String(formData.get('lien') ?? ''), now);
    return 'lien-enregistre';
  });
}

/** PUB-07 : premier commentaire du post. */
export async function setFirstCommentAction(postId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    await setFirstComment(database(), userId, postId, String(formData.get('commentaire') ?? ''), now);
    return 'commentaire-enregistre';
  });
}

/** PUB-08 : mention d'une page d'entreprise, à placer dans le texte. */
export async function mentionAction(postId: string, formData: FormData): Promise<void> {
  if (!UUID.test(postId)) notFound();
  const userId = await requireUserId();
  const cipher = tokenCipher();
  let target: string;
  try {
    if (cipher === null) throw new RefusedError('mention_indisponible', 'Chiffrement non configuré.');
    const found = await resolvePageMention(database(), { pages: linkedinPages(), cipher }, userId, postId, String(formData.get('page') ?? ''));
    target = `/posts/${postId}?message=mention-prete&mention=${encodeURIComponent(found.mention)}#mention`;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) target = `/posts/${postId}?message=interdit`;
    else if (error instanceof RefusedError) target = `/posts/${postId}?message=${encodeURIComponent(error.code)}#mention`;
    else throw error;
  }
  redirect(target);
}

/** VIS-10 : carrousel PDF à partir des points clés du visuel. */
export async function carouselAction(postId: string, formData: FormData): Promise<void> {
  await run(postId, formData, async (userId, now) => {
    await makeCarousel(database(), mediaStore(), userId, postId, now);
    return 'carrousel-pret';
  });
}

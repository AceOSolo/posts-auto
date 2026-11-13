'use server';

import { DEFAULT_WORKSPACE_CALENDAR, atLocal } from '@posts-auto/core';
import { asUser } from '@posts-auto/db';
import { ModelError } from '@posts-auto/ai';
import { ForbiddenError, NotFoundError, RefusedError, type UploadedPhoto, createPostRequest, interpretPostRequest } from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database, mediaStore, model, usdToEur } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (form: FormData, name: string) => String(form.get(name) ?? '');

/** IDE-03 : dépôt d'une demande de post ; la tâche de fond la traite dans l'heure (IDE-06). */
export async function createRequestAction(workspaceId: string, form: FormData): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const now = new Date();
  let message: string;
  try {
    // Date et heure souhaitées, saisies à l'heure de l'espace.
    let wishedAt: Date | null = null;
    const day = text(form, 'date');
    if (day !== '') {
      const timeZone = await asUser(database(), userId, async (trx) => (await trx.selectFrom('workspaces').select('timezone').where('id', '=', workspaceId).executeTakeFirst())?.timezone);
      if (timeZone === undefined) throw new NotFoundError('Espace');
      try {
        wishedAt = atLocal(day, text(form, 'heure') || '12:00', { ...DEFAULT_WORKSPACE_CALENDAR, timeZone });
      } catch {
        wishedAt = null;
      }
      if (wishedAt === null) throw new RefusedError('date_invalide', 'Date ou heure invalide.');
    }
    const photos: UploadedPhoto[] = [];
    for (const file of form.getAll('photos')) {
      if (file instanceof File && file.size > 0) photos.push({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type });
    }
    await createPostRequest(
      database(),
      mediaStore(),
      userId,
      workspaceId,
      {
        rawText: text(form, 'demande'),
        links: text(form, 'liens'),
        wishedAt,
        accountIds: form.getAll('comptes').map(String).filter((id) => UUID.test(id)),
        photos,
      },
      now,
    );
    message = 'demande-envoyee';
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) message = 'interdit';
    else if (error instanceof RefusedError) message = error.code;
    else throw error;
  }
  revalidatePath(`/demandes/${workspaceId}`);
  redirect(`/demandes/${workspaceId}?message=${encodeURIComponent(message)}`);
}

export type PrefillResult =
  | {
      readonly ok: true;
      readonly accountIds: readonly string[];
      readonly wishedDate: string | null;
      readonly wishedTime: string | null;
      readonly links: readonly string[];
      readonly title: string;
      readonly toSpecify: readonly string[];
      readonly suspicious: boolean;
    }
  | { readonly ok: false; readonly message: string };

/** IDE-04 : pré-remplissage du formulaire par l'IA (avec JavaScript ; le formulaire marche sans). */
export async function interpretRequestAction(workspaceId: string, rawText: string): Promise<PrefillResult> {
  if (!UUID.test(workspaceId)) return { ok: false, message: 'Espace inconnu.' };
  const userId = await requireUserId();
  try {
    const result = await interpretPostRequest(database(), model(), userId, workspaceId, String(rawText ?? ''), new Date(), usdToEur());
    return {
      ok: true,
      accountIds: result.accountIds,
      wishedDate: result.wishedDate,
      wishedTime: result.wishedTime,
      links: result.links,
      title: result.title,
      toSpecify: result.toSpecify,
      suspicious: result.suspiciousInstructions.length > 0,
    };
  } catch (error) {
    if (error instanceof RefusedError) return { ok: false, message: error.message };
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return { ok: false, message: 'Vous ne pouvez pas faire de demande dans cet espace.' };
    if (error instanceof ModelError) return { ok: false, message: 'L’IA n’a pas pu lire la demande. Remplissez les champs à la main.' };
    throw error;
  }
}

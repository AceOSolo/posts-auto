'use server';

import { DEFAULT_WORKSPACE_CALENDAR, atLocal } from '@posts-auto/core';
import { asUser } from '@posts-auto/db';
import { ForbiddenError, NotFoundError, RefusedError, type UploadedPhoto, createPostRequest } from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database, mediaStore } from '../../../server/context.ts';
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

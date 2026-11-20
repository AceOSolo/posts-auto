'use server';

import { ForbiddenError, NotFoundError, RefusedError, createWorkspace } from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nouvel espace (un client de l'agence) ; on poursuit par son assistant de démarrage. */
export async function createWorkspaceAction(workspaceId: string, form: FormData): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let target: string;
  try {
    const created = await createWorkspace(database(), userId, workspaceId, String(form.get('nom') ?? ''), new Date());
    target = `/demarrage/${created}?message=espace-cree`;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) target = `/espaces/${workspaceId}?message=interdit`;
    else if (error instanceof RefusedError) target = `/espaces/${workspaceId}?message=${encodeURIComponent(error.code)}`;
    else throw error;
  }
  revalidatePath('/', 'layout');
  redirect(target);
}

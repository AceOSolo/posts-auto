'use server';

import { ForbiddenError, NotFoundError, setMonthlyReportEmail } from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SUI-05 : envoi automatique du rapport mensuel. */
export async function reportEmailAction(workspaceId: string, enabled: boolean): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let message = enabled ? 'rapport-par-email' : 'rapport-sans-email';
  try {
    await setMonthlyReportEmail(database(), userId, workspaceId, enabled);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) message = 'interdit';
    else throw error;
  }
  revalidatePath(`/tableau/${workspaceId}`);
  redirect(`/tableau/${workspaceId}?message=${message}#statistiques`);
}

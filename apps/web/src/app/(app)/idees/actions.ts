'use server';

import { ModelError } from '@posts-auto/ai';
import { ForbiddenError, NotFoundError, RefusedError, ideasFromArticle, saveIdea, setIdeaStatus } from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database, model, usdToEur } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(workspaceId: string, action: (userId: string, now: Date) => Promise<string>): Promise<never> {
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
  revalidatePath(`/idees/${workspaceId}`);
  redirect(`/idees/${workspaceId}?message=${encodeURIComponent(message)}`);
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

/** IDE-01 : propose (ideaId null) ou modifie une idée. */
export async function saveIdeaAction(workspaceId: string, ideaId: string | null, form: FormData): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    if (ideaId !== null && !UUID.test(ideaId)) throw new NotFoundError('Idée');
    await saveIdea(
      database(),
      userId,
      workspaceId,
      ideaId,
      {
        title: text(form, 'titre'),
        details: text(form, 'details'),
        link: text(form, 'lien'),
        startsOn: text(form, 'debut'),
        endsOn: text(form, 'fin'),
        eventOn: text(form, 'evenement'),
        accountIds: form.getAll('comptes').map(String).filter((id) => UUID.test(id)),
      },
      now,
    );
    return ideaId === null ? 'idee-proposee' : 'idee-modifiee';
  });
}

export async function ideaStatusAction(workspaceId: string, ideaId: string, status: 'new' | 'kept' | 'dismissed'): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    if (!UUID.test(ideaId)) throw new NotFoundError('Idée');
    await setIdeaStatus(database(), userId, workspaceId, ideaId, status, now);
    return `idee-${status}`;
  });
}

/** Déclinaison d'un article en idées : l'IA en tire plusieurs angles, déposés comme idées. */
export async function repurposeAction(workspaceId: string, form: FormData): Promise<void> {
  await run(workspaceId, async (userId, now) => {
    try {
      const outcome = await ideasFromArticle(database(), model(), userId, workspaceId, text(form, 'article'), now, { usdToEur: usdToEur() });
      return outcome.suspicious.length > 0 ? 'idees-declinees-consignes' : 'idees-declinees';
    } catch (error) {
      if (error instanceof ModelError) return 'ia-indisponible';
      throw error;
    }
  });
}

'use server';

import { randomUUID } from 'node:crypto';
import { ModelError } from '@posts-auto/ai';
import { type EmojiPolicy, parseEditorialRules } from '@posts-auto/core';
import {
  ForbiddenError,
  NotFoundError,
  type OfferPricing,
  type OfferStatus,
  RefusedError,
  addSource,
  deleteOfferItem,
  deleteSource,
  proposeEditorialLineFor,
  saveEditorialLine,
  saveOfferItem,
  setSourceEnabled,
} from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database, mediaStore, model, usdToEur } from '../../../server/context.ts';
import { editorialProposalKey } from '../../../server/drafts.ts';
import { requireUserId } from '../../../server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(workspaceId: string, anchor: string, action: (userId: string, now: Date) => Promise<string>): Promise<never> {
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
  revalidatePath(`/ligne/${workspaceId}`);
  redirect(`/ligne/${workspaceId}?message=${encodeURIComponent(message)}#${anchor}`);
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '');
const number = (form: FormData, name: string) => {
  const value = Number.parseInt(text(form, name), 10);
  return Number.isNaN(value) ? undefined : value;
};

/**
 * ONB-04 : l'IA propose la ligne éditoriale à partir du site et de posts collés. Rien n'est
 * enregistré : la proposition pré-remplit le formulaire, que la personne corrige et valide.
 */
export async function proposeLineAction(workspaceId: string, form: FormData): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let destination: string;
  try {
    const proposal = await proposeEditorialLineFor(database(), model(), userId, workspaceId, { website: text(form, 'site'), posts: text(form, 'posts') }, new Date(), { usdToEur: usdToEur() });
    const id = randomUUID();
    await mediaStore().write(editorialProposalKey(workspaceId, id), new TextEncoder().encode(JSON.stringify(proposal)));
    destination = `/ligne/${workspaceId}?proposition=${id}#ligne`;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    const code = error instanceof ForbiddenError ? 'interdit' : error instanceof RefusedError ? error.code : error instanceof ModelError ? 'ia-indisponible' : null;
    if (code === null) throw error;
    destination = `/ligne/${workspaceId}?message=${encodeURIComponent(code)}#proposer`;
  }
  redirect(destination);
}

/** EDI-01, EDI-02 : enregistre une nouvelle version de la ligne éditoriale. */
export async function saveLineAction(workspaceId: string, form: FormData): Promise<void> {
  await run(workspaceId, 'ligne', async (userId, now) => {
    const rules = parseEditorialRules({
      maxHashtags: number(form, 'hashtags'),
      emojis: text(form, 'emojis') as EmojiPolicy,
      minLength: number(form, 'longueur-min'),
      maxLength: number(form, 'longueur-max'),
      linksAtEnd: form.get('liens-en-fin') === 'on',
      askQuestion: form.get('question') === 'on',
    });
    const result = await saveEditorialLine(
      database(),
      userId,
      workspaceId,
      {
        positioning: text(form, 'positionnement'),
        offers: text(form, 'offres'),
        audiences: text(form, 'cibles'),
        allowedProofs: text(form, 'preuves'),
        tone: text(form, 'ton'),
        bannedPhrases: text(form, 'interdits').split(/\r?\n/),
        rules,
      },
      now,
    );
    return result.changed.length === 0 ? 'ligne-inchangee' : 'ligne-enregistree';
  });
}

/** EDI-03 : ajoute (itemId null) ou modifie une offre. */
export async function saveOfferAction(workspaceId: string, itemId: string | null, form: FormData): Promise<void> {
  await run(workspaceId, 'offre', async (userId, now) => {
    if (itemId !== null && !UUID.test(itemId)) throw new NotFoundError('Offre');
    const pricing = text(form, 'prix');
    await saveOfferItem(
      database(),
      userId,
      workspaceId,
      itemId,
      {
        name: text(form, 'nom'),
        description: text(form, 'description'),
        status: text(form, 'disponibilite') as OfferStatus,
        pricing: (pricing === 'free' || pricing === 'paid' ? pricing : null) as OfferPricing,
      },
      now,
    );
    return 'offre-enregistree';
  });
}

export async function deleteOfferAction(workspaceId: string, itemId: string): Promise<void> {
  await run(workspaceId, 'offre', async (userId, now) => {
    if (!UUID.test(itemId)) throw new NotFoundError('Offre');
    await deleteOfferItem(database(), userId, workspaceId, itemId, now);
    return 'offre-supprimee';
  });
}

/** GEN-09 : sources de veille (flux RSS ou Atom). */
export async function addSourceAction(workspaceId: string, form: FormData): Promise<void> {
  await run(workspaceId, 'sources', async (userId, now) => {
    await addSource(database(), userId, workspaceId, { url: text(form, 'adresse'), label: text(form, 'libelle') }, now);
    return 'source-ajoutee';
  });
}

export async function toggleSourceAction(workspaceId: string, sourceId: string, enabled: boolean): Promise<void> {
  await run(workspaceId, 'sources', async (userId, now) => {
    if (!UUID.test(sourceId)) throw new NotFoundError('Source');
    await setSourceEnabled(database(), userId, workspaceId, sourceId, enabled, now);
    return enabled ? 'source-reprise' : 'source-suspendue';
  });
}

export async function deleteSourceAction(workspaceId: string, sourceId: string): Promise<void> {
  await run(workspaceId, 'sources', async (userId, now) => {
    if (!UUID.test(sourceId)) throw new NotFoundError('Source');
    await deleteSource(database(), userId, workspaceId, sourceId, now);
    return 'source-supprimee';
  });
}

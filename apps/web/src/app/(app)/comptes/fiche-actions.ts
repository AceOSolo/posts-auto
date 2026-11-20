'use server';

import type { IsoWeekday, UsualSlot } from '@posts-auto/core';
import {
  type AccountProfileInput,
  ForbiddenError,
  NotFoundError,
  RefusedError,
  type Sensitivity,
  type Voice,
  addReferencePost,
  declareAvatar,
  deleteReferencePost,
  revokeAvatar,
  getAccountProfile,
  saveAccountProfile,
  saveLearnedPreferences,
} from '@posts-auto/services';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { database, mediaStore } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';
import { SLOT_ROWS } from './fiche-constants.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(workspaceId: string, accountId: string, anchor: string, action: (userId: string, now: Date) => Promise<string>): Promise<never> {
  if (!UUID.test(workspaceId) || !UUID.test(accountId)) notFound();
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
  const path = `/comptes/${workspaceId}/fiche/${accountId}`;
  revalidatePath(path);
  redirect(`${path}?message=${encodeURIComponent(message)}#${anchor}`);
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

/** EDI-04 : la fiche entière pour la gestion du contenu ; ton et sujets à éviter pour le titulaire. */
export async function saveProfileAction(workspaceId: string, accountId: string, form: FormData): Promise<void> {
  await run(workspaceId, accountId, 'fiche', async (userId, now) => {
    const { rights } = await getAccountProfile(database(), userId, accountId);
    const input: AccountProfileInput = { tenor: text(form, 'teneur'), avoid: text(form, 'a-eviter') };
    if (rights.canEditAll) {
      const slots: UsualSlot[] = [];
      for (let i = 0; i < SLOT_ROWS; i += 1) {
        const weekday = Number(text(form, `jour-${i}`));
        const time = text(form, `heure-${i}`);
        if (weekday >= 1 && weekday <= 7 && time !== '') slots.push({ weekday: weekday as IsoWeekday, time });
      }
      // Un champ absent du formulaire laisse la valeur enregistrée inchangée.
      const voice = text(form, 'voix');
      Object.assign(input, {
        ...(form.has('voix') && { voice: voice === 'je' || voice === 'nous' ? (voice as Voice) : null }),
        ...(form.has('sensibilite') && { sensitivity: text(form, 'sensibilite') as Sensitivity }),
        ...(form.has('rythme') && { postsPerWeek: Number.parseInt(text(form, 'rythme'), 10) }),
        ...(form.has('options') && { optionalPerWeek: Number.parseInt(text(form, 'options'), 10) }),
        ...(form.has('jour-0') && { usualSlots: slots }),
        ...(form.has('part-photos') && { aiImageRatio: Number(text(form, 'part-photos')) }),
      });
    }
    await saveAccountProfile(database(), userId, accountId, input, now);
    return 'fiche-enregistree';
  });
}

/** EDI-05 : exemple « à imiter » ou « à éviter ». */
export async function addExampleAction(workspaceId: string, accountId: string, form: FormData): Promise<void> {
  await run(workspaceId, accountId, 'exemples', async (userId, now) => {
    const label = text(form, 'etiquette') === 'eviter' ? 'eviter' : 'imiter';
    await addReferencePost(database(), userId, accountId, { body: text(form, 'texte'), label, note: text(form, 'note') }, now);
    return 'exemple-ajoute';
  });
}

export async function deleteExampleAction(workspaceId: string, accountId: string, referenceId: string): Promise<void> {
  await run(workspaceId, accountId, 'exemples', async (userId, now) => {
    if (!UUID.test(referenceId)) throw new NotFoundError('Exemple');
    await deleteReferencePost(database(), userId, accountId, referenceId, now);
    return 'exemple-supprime';
  });
}

/** EDI-06 : résumé des préférences, visible et modifiable. */
export async function savePreferencesAction(workspaceId: string, accountId: string, form: FormData): Promise<void> {
  await run(workspaceId, accountId, 'preferences', async (userId, now) => {
    await saveLearnedPreferences(database(), userId, accountId, text(form, 'resume'), now);
    return 'preferences-apprises-enregistrees';
  });
}

/** VIS-06 : avatar de marque déclaré par le titulaire, avec son consentement écrit. */
export async function declareAvatarAction(workspaceId: string, accountId: string, form: FormData): Promise<void> {
  const file = form.get('avatar');
  const forwarded = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim();
  await run(workspaceId, accountId, 'avatar', async (userId, now) => {
    if (!(file instanceof File) || file.size === 0) throw new RefusedError('image_requise', 'Choisissez une image.');
    await declareAvatar(
      database(),
      mediaStore(),
      userId,
      accountId,
      { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, consent: form.get('accord') === 'on', ...(forwarded && /^[\d.:a-f]+$/i.test(forwarded) && { ip: forwarded }) },
      now,
    );
    return 'avatar-declare';
  });
}

export async function revokeAvatarAction(workspaceId: string, accountId: string): Promise<void> {
  await run(workspaceId, accountId, 'avatar', async (userId, now) => {
    await revokeAvatar(database(), userId, accountId, now);
    return 'avatar-retire';
  });
}

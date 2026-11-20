'use server';

import { randomUUID } from 'node:crypto';
import {
  ForbiddenError,
  NotFoundError,
  RefusedError,
  addLibraryPhotos,
  proposeBrandFromWebsite,
  duplicateTemplate,
  recolorGalleryTemplates,
  removeFromLibrary,
  saveBranding,
  saveTemplate,
  setTemplateArchived,
  updateLibraryPhoto,
} from '@posts-auto/services';
import type { FontKey } from '@posts-auto/visuals';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database, mediaStore } from '../../../server/context.ts';
import { brandProposalKey } from '../../../server/drafts.ts';
import { requireUserId } from '../../../server/session.ts';
import { definitionFromForm } from '../../../server/template-form.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Exécute l'action puis revient sur la page indiquée avec un code de message ; le détail
 * d'un refus (définition de modèle invalide) est transmis pour être affiché tel quel.
 */
async function run(ids: readonly string[], back: (result: string | null) => string, action: (userId: string, now: Date) => Promise<{ message: string; result?: string }>): Promise<never> {
  if (!ids.every((id) => UUID.test(id))) notFound();
  const userId = await requireUserId();
  let message: string;
  let result: string | null = null;
  let detail: string | null = null;
  try {
    const outcome = await action(userId, new Date());
    message = outcome.message;
    result = outcome.result ?? null;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) message = 'interdit';
    else if (error instanceof RefusedError) {
      message = error.code;
      if (error.code === 'modele_invalide') detail = error.message;
    } else throw error;
  }
  const url = back(result);
  revalidatePath(url.split(/[?#]/)[0] as string);
  const [path, anchor] = url.split('#');
  redirect(`${path}${path?.includes('?') ? '&' : '?'}message=${encodeURIComponent(message)}${detail ? `&detail=${encodeURIComponent(detail)}` : ''}${anchor ? `#${anchor}` : ''}`);
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '');
const files = (form: FormData, name: string) => form.getAll(name).filter((value): value is File => value instanceof File && value.size > 0);

/** VIS-02 : enregistre le modèle édité (ou ajoute une zone, puis revient à l'éditeur). */
export async function saveTemplateAction(workspaceId: string, templateId: string, form: FormData): Promise<void> {
  const adding = text(form, 'nouvelle-zone') !== '';
  await run([workspaceId, templateId], () => `/visuels/${workspaceId}/modeles/${templateId}${adding ? '#zones' : ''}`, async (userId, now) => {
    const account = text(form, 'compte');
    await saveTemplate(database(), userId, workspaceId, { id: templateId, name: text(form, 'nom'), accountId: UUID.test(account) ? account : null, definition: definitionFromForm(form) }, now);
    return { message: adding ? 'zone-ajoutee' : 'modele-enregistre' };
  });
}

/** Nouveau modèle : copie d'un modèle existant, ouverte dans l'éditeur. */
export async function duplicateTemplateAction(workspaceId: string, form: FormData): Promise<void> {
  const source = text(form, 'modele');
  await run([workspaceId, source], (id) => (id === null ? `/visuels/${workspaceId}#modeles` : `/visuels/${workspaceId}/modeles/${id}`), async (userId, now) => {
    const id = await duplicateTemplate(database(), userId, source, now);
    return { message: 'modele-copie', result: id };
  });
}

export async function archiveTemplateAction(workspaceId: string, templateId: string, archived: boolean): Promise<void> {
  await run([workspaceId, templateId], () => `/visuels/${workspaceId}#modeles`, async (userId, now) => {
    await setTemplateArchived(database(), userId, templateId, archived, now);
    return { message: archived ? 'modele-archive' : 'modele-restaure' };
  });
}

/** ONB-05, VIS-05 : charte visuelle et budget d'images. */
export async function saveBrandingAction(workspaceId: string, form: FormData): Promise<void> {
  await run([workspaceId], () => `/visuels/${workspaceId}#charte`, async (userId, now) => {
    const [logo] = files(form, 'logo');
    // Le champ du budget n'est présent que pour le propriétaire et les admins.
    const budget = text(form, 'budget').trim();
    await saveBranding(
      database(),
      mediaStore(),
      userId,
      workspaceId,
      {
        primary: text(form, 'principale'),
        secondary: text(form, 'accent'),
        light: text(form, 'claire'),
        dark: text(form, 'sombre'),
        ...(text(form, 'police') !== '' && { font: text(form, 'police') as FontKey }),
        ...(logo !== undefined
          ? { logo: { bytes: new Uint8Array(await logo.arrayBuffer()), mime: logo.type } }
          : form.get('retirer-logo') === 'on'
            ? { logo: null }
            : form.get('logo-du-site') === 'on' && text(form, 'logo-site') !== ''
              ? { logoAssetId: text(form, 'logo-site') }
              : {}),
        ...(budget !== '' && { imageBudgetMonthly: Number(budget) }),
      },
      now,
    );
    return { message: 'charte-enregistree' };
  });
}

export async function recolorAction(workspaceId: string): Promise<void> {
  await run([workspaceId], () => `/visuels/${workspaceId}#modeles`, async (userId, now) => {
    await recolorGalleryTemplates(database(), userId, workspaceId, now);
    return { message: 'modeles-recolores' };
  });
}

/** VIS-08 : ajout de photos à la médiathèque. */
export async function addLibraryAction(workspaceId: string, form: FormData): Promise<void> {
  await run([workspaceId], () => `/visuels/${workspaceId}/photos`, async (userId, now) => {
    const photos = await Promise.all(
      files(form, 'photos').map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, label: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') })),
    );
    const count = await addLibraryPhotos(database(), mediaStore(), userId, workspaceId, photos, { folder: text(form, 'dossier'), tags: text(form, 'mots-cles') }, now);
    return { message: count > 1 ? 'photos-mediatheque' : 'photo-mediatheque' };
  });
}

export async function updateLibraryAction(workspaceId: string, assetId: string, form: FormData): Promise<void> {
  await run([workspaceId, assetId], () => `/visuels/${workspaceId}/photos#photo-${assetId}`, async (userId, now) => {
    await updateLibraryPhoto(database(), userId, assetId, { label: text(form, 'nom'), folder: text(form, 'dossier'), tags: text(form, 'mots-cles') }, now);
    return { message: 'photo-classee' };
  });
}

export async function removeLibraryAction(workspaceId: string, assetId: string): Promise<void> {
  await run([workspaceId, assetId], () => `/visuels/${workspaceId}/photos`, async (userId, now) => {
    await removeFromLibrary(database(), userId, assetId, now);
    return { message: 'photo-retiree-mediatheque' };
  });
}

/** ONB-05 : charte proposée à partir du site web ; le formulaire est pré-rempli, rien n'est enregistré. */
export async function proposeBrandAction(workspaceId: string, form: FormData): Promise<void> {
  await run([workspaceId], (id) => (id === null ? `/visuels/${workspaceId}#charte` : `/visuels/${workspaceId}?charte=${id}#charte`), async (userId, now) => {
    const proposal = await proposeBrandFromWebsite(database(), mediaStore(), userId, workspaceId, text(form, 'site'), now);
    const id = randomUUID();
    await mediaStore().write(brandProposalKey(workspaceId, id), new TextEncoder().encode(JSON.stringify(proposal)));
    return { message: 'charte-proposee', result: id };
  });
}

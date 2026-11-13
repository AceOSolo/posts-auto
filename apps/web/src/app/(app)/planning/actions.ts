'use server';

import { type PlannedEntry, type RowTarget, pamEntries, parseCsv, readPamLayout, readSubjectSheet } from '@posts-auto/core';
import {
  ForbiddenError,
  NotFoundError,
  RefusedError,
  addPlanningEntry,
  canManageContent,
  configureGeneration,
  deleteEvent,
  deletePlanningEntry,
  deleteSubject,
  importPlanning,
  importSubjects,
  parseRowKey,
  placeSubject,
  requestGeneration,
  saveEvent,
  saveSubject,
  setAsidePlanningEntry,
  updatePlanningEntry,
  workspaceRole,
} from '@posts-auto/services';
import { asUser } from '@posts-auto/db';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { database, mediaStore } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';
import { IMPORT_MAX_BYTES, draftKey } from './import-draft.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exécute l'action et revient sur `path` avec un code de message (sans texte libre dans l'adresse). */
async function run(workspaceId: string, path: string, action: (userId: string, now: Date) => Promise<string>): Promise<never> {
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
  revalidatePath(`/planning/${workspaceId}`, 'layout');
  const [base, hash] = path.split('#');
  const separator = (base ?? '').includes('?') ? '&' : '?';
  redirect(`${base}${separator}message=${encodeURIComponent(message)}${hash ? `#${hash}` : ''}`);
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '');
const cellPath = (workspaceId: string, rowKey: string, week: string) =>
  `/planning/${workspaceId}/case?ligne=${encodeURIComponent(rowKey)}&semaine=${encodeURIComponent(week)}`;

function requireRow(rowKey: string) {
  const row = parseRowKey(rowKey);
  if (row === null) throw new NotFoundError('Ligne');
  return row;
}

// --- Cases (PLA-02) ---

export async function addEntryAction(workspaceId: string, rowKey: string, week: string, form: FormData): Promise<void> {
  await run(workspaceId, cellPath(workspaceId, rowKey, week), async (userId, now) => {
    await addPlanningEntry(database(), userId, workspaceId, requireRow(rowKey), week, text(form, 'sujet'), now);
    return 'sujet-ajoute';
  });
}

export async function updateEntryAction(workspaceId: string, entryId: string, rowKey: string, week: string, form: FormData): Promise<void> {
  await run(workspaceId, cellPath(workspaceId, rowKey, week), async (userId, now) => {
    if (!UUID.test(entryId)) throw new NotFoundError('Sujet');
    await updatePlanningEntry(database(), userId, workspaceId, entryId, text(form, 'sujet'), now);
    return 'sujet-modifie';
  });
}

export async function deleteEntryAction(workspaceId: string, entryId: string, rowKey: string, week: string): Promise<void> {
  await run(workspaceId, cellPath(workspaceId, rowKey, week), async (userId, now) => {
    if (!UUID.test(entryId)) throw new NotFoundError('Sujet');
    await deletePlanningEntry(database(), userId, workspaceId, entryId, now);
    return 'sujet-supprime';
  });
}

/** Met de côté (motif obligatoire) ou reprend (`reprendre`) un sujet. */
export async function setAsideAction(workspaceId: string, entryId: string, rowKey: string, week: string, form: FormData): Promise<void> {
  await run(workspaceId, cellPath(workspaceId, rowKey, week), async (userId, now) => {
    if (!UUID.test(entryId)) throw new NotFoundError('Sujet');
    const resume = form.get('reprendre') !== null;
    await setAsidePlanningEntry(database(), userId, workspaceId, entryId, resume ? null : text(form, 'motif'), now);
    return resume ? 'sujet-repris' : 'sujet-mis-de-cote';
  });
}

// --- Banque de sujets (PLA-03) ---

function subjectInput(form: FormData) {
  const account = text(form, 'compte');
  return {
    accountId: UUID.test(account) ? account : null,
    subject: text(form, 'sujet'),
    theme: text(form, 'theme'),
    angle: text(form, 'angle'),
    format: text(form, 'format'),
    offer: text(form, 'offre'),
    audience: text(form, 'cible'),
    published: form.get('publie') === 'on',
  };
}

export async function saveSubjectAction(workspaceId: string, subjectId: string | null, form: FormData): Promise<void> {
  await run(workspaceId, `/planning/${workspaceId}/banque#banque`, async (userId, now) => {
    if (subjectId !== null && !UUID.test(subjectId)) throw new NotFoundError('Sujet');
    await saveSubject(database(), userId, workspaceId, subjectId, subjectInput(form), now);
    return 'banque-enregistree';
  });
}

export async function deleteSubjectAction(workspaceId: string, subjectId: string): Promise<void> {
  await run(workspaceId, `/planning/${workspaceId}/banque#banque`, async (userId, now) => {
    if (!UUID.test(subjectId)) throw new NotFoundError('Sujet');
    await deleteSubject(database(), userId, workspaceId, subjectId, now);
    return 'banque-supprimee';
  });
}

export async function placeSubjectAction(workspaceId: string, subjectId: string, form: FormData): Promise<void> {
  await run(workspaceId, `/planning/${workspaceId}/banque#banque`, async (userId, now) => {
    const accountId = text(form, 'compte');
    if (!UUID.test(subjectId) || !UUID.test(accountId)) throw new RefusedError('compte_inconnu', 'Choisissez un compte.');
    await placeSubject(database(), userId, workspaceId, subjectId, accountId, text(form, 'semaine'), now);
    return 'sujet-place';
  });
}

// --- Événements (PLA-04) ---

export async function saveEventAction(workspaceId: string, eventId: string | null, form: FormData): Promise<void> {
  await run(workspaceId, `/planning/${workspaceId}/evenements`, async (userId, now) => {
    if (eventId !== null && !UUID.test(eventId)) throw new NotFoundError('Événement');
    await saveEvent(
      database(),
      userId,
      workspaceId,
      eventId,
      {
        title: text(form, 'titre'),
        startsOn: text(form, 'debut'),
        endsOn: text(form, 'fin'),
        link: text(form, 'lien'),
        details: text(form, 'details'),
        recurrence: (['weekly', 'monthly', 'yearly'] as const).find((r) => r === text(form, 'recurrence')) ?? 'none',
        recurrenceUntil: text(form, 'jusqua'),
        accountIds: form.getAll('comptes').map(String).filter((id) => UUID.test(id)),
      },
      now,
    );
    return 'evenement-enregistre';
  });
}

export async function deleteEventAction(workspaceId: string, eventId: string): Promise<void> {
  await run(workspaceId, `/planning/${workspaceId}/evenements`, async (userId, now) => {
    if (!UUID.test(eventId)) throw new NotFoundError('Événement');
    await deleteEvent(database(), userId, workspaceId, eventId, now);
    return 'evenement-supprime';
  });
}

// --- Rédaction (GEN-01) ---

export async function requestGenerationAction(workspaceId: string): Promise<void> {
  await run(workspaceId, `/planning/${workspaceId}/redactions`, async (userId, now) => {
    await requestGeneration(database(), userId, workspaceId, now);
    return 'redaction-demandee';
  });
}

export async function configureGenerationAction(workspaceId: string, form: FormData): Promise<void> {
  await run(workspaceId, `/planning/${workspaceId}/redactions`, async (userId, now) => {
    const minutes = /^(\d{2}):(\d{2})$/.exec(text(form, 'heure'));
    const day = Number(text(form, 'jour'));
    if (minutes === null || !(day >= 1 && day <= 7)) throw new RefusedError('cron_invalide', 'Programmation invalide.');
    const cron = `${Number(minutes[2])} ${Number(minutes[1])} * * ${day}`;
    await configureGeneration(database(), userId, workspaceId, { auto: form.get('auto') === 'on', cron }, now);
    return 'redaction-programmee';
  });
}

// --- Import (PLA-05) ---

/** Étape 1 : garde le fichier en brouillon et affiche l'aperçu. */
export async function previewImportAction(workspaceId: string, form: FormData): Promise<void> {
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  // Rien n'est écrit pour une personne qui ne peut pas modifier ce planning.
  const allowed = await asUser(database(), userId, async (trx) => canManageContent(await workspaceRole(trx, userId, workspaceId)));
  if (!allowed) redirect(`/planning/${workspaceId}/import?message=interdit`);
  const file = form.get('fichier');
  let content = text(form, 'contenu');
  if (file instanceof File && file.size > 0) {
    if (file.size > IMPORT_MAX_BYTES) redirect(`/planning/${workspaceId}/import?message=fichier_trop_gros`);
    content = await file.text();
  }
  if (content.trim() === '') redirect(`/planning/${workspaceId}/import?message=fichier_vide`);
  const kind = text(form, 'type') === 'banque' ? 'banque' : 'planning';
  const year = Number.parseInt(text(form, 'annee'), 10);
  const draftId = randomUUID();
  await mediaStore().write(draftKey(workspaceId, draftId), new TextEncoder().encode(content.slice(0, IMPORT_MAX_BYTES)));
  redirect(`/planning/${workspaceId}/import?brouillon=${draftId}&type=${kind}&annee=${Number.isNaN(year) ? new Date().getFullYear() : year}`);
}

/** Étape 2 : applique le choix fait pour chaque ligne et crée les sujets. */
export async function runImportAction(workspaceId: string, draftId: string, kind: 'planning' | 'banque', year: number, form: FormData): Promise<void> {
  await run(workspaceId, `/planning/${workspaceId}`, async (userId, now) => {
    if (!UUID.test(draftId)) throw new NotFoundError('Brouillon');
    const csv = new TextDecoder().decode(await mediaStore().read(draftKey(workspaceId, draftId)));
    const table = parseCsv(csv);
    if (kind === 'banque') {
      const rows = readSubjectSheet(table);
      if (rows === null) throw new RefusedError('format_non_reconnu', 'Format non reconnu.');
      const account = text(form, 'compte');
      const result = await importSubjects(database(), userId, workspaceId, UUID.test(account) ? account : null, rows, now);
      return result.created > 0 ? 'import-termine' : 'import-rien';
    }
    const layout = readPamLayout(table, year);
    if (layout === null) throw new RefusedError('format_non_reconnu', 'Format non reconnu.');
    const targets = new Map<string, RowTarget>();
    layout.rows.forEach((row, i) => {
      const choice = text(form, `ligne-${i}`);
      if (choice === 'evenement' || choice === 'canal') targets.set(row.label, { kind: choice === 'evenement' ? 'event' : 'channel', label: row.label.slice(0, 100) });
      else if (UUID.test(choice)) targets.set(row.label, { kind: 'account', accountId: choice });
    });
    const entries: PlannedEntry[] = pamEntries(layout, targets);
    const result = await importPlanning(database(), userId, workspaceId, entries, now);
    return result.created > 0 ? 'import-termine' : 'import-rien';
  });
}

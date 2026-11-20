/**
 * « Refaire le visuel » (VIS-13), toutes les minutes : tâches déposées depuis l'application
 * par le titulaire ou l'équipe, avec une consigne et un choix pour la photo (la garder, en
 * changer, s'en passer).
 *
 * Le droit de modifier le post et RÈG-07 sont appliqués au dépôt de la tâche. Ici, le
 * visuel n'est remplacé que si le post peut encore changer (ni parti, ni sorti du circuit) ;
 * sinon la tâche est abandonnée. Une tâche est prise avec un bail ; après trois échecs,
 * elle est marquée en échec et l'erreur s'affiche sur le post.
 */
import { ModelError, type TextModel } from '@posts-auto/ai';
import { addMinutes } from '@posts-auto/core';
import { type Database, asSystem } from '@posts-auto/db';
import type { ImageGenerator } from '@posts-auto/visuals';
import type { MediaStore } from '../media/media-store.ts';
import { type AccountVisual, type CanvaRenderer, prepareVisual, storeVisual } from './prepare.ts';
import { imagesGeneratedFor, loadPreviousVisual, openVisualSession, photoPlan } from './session.ts';

export const VISUAL_TASK_MAX_ATTEMPTS = 3;
export const VISUAL_TASK_LEASE_MINUTES = 10;
const BATCH = 5;
/** Statuts où le visuel d'un post peut encore changer. */
export const VISUAL_EDITABLE_STATUSES = ['brouillon', 'a_valider', 'modif', 'valide'] as const;

export interface VisualJobDeps {
  readonly db: Database;
  readonly model: TextModel;
  readonly media: MediaStore;
  readonly images?: ImageGenerator | null;
  readonly canva?: CanvaRenderer | null;
  readonly clock?: () => Date;
  readonly usdToEur?: number;
}

export interface VisualTickReport {
  readonly done: readonly string[];
  readonly dropped: readonly string[];
  readonly retrying: readonly string[];
  readonly failed: readonly string[];
}

export async function runVisualTick(deps: VisualJobDeps): Promise<VisualTickReport> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const claimed = await asSystem(deps.db, async (trx) => {
    const rows = await trx
      .selectFrom('visual_tasks')
      .select('post_id')
      .where('failed_at', 'is', null)
      .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', now)]))
      .orderBy('created_at')
      .limit(BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    const ids = rows.map((r) => r.post_id);
    if (ids.length > 0) {
      await trx
        .updateTable('visual_tasks')
        .set((eb) => ({ lease_until: addMinutes(now, VISUAL_TASK_LEASE_MINUTES), attempts: eb('attempts', '+', 1) }))
        .where('post_id', 'in', ids)
        .execute();
    }
    return ids;
  });

  const report = { done: [] as string[], dropped: [] as string[], retrying: [] as string[], failed: [] as string[] };
  for (const postId of claimed) report[await processTask(deps, postId, clock)].push(postId);
  return report;
}

async function processTask(deps: VisualJobDeps, postId: string, clock: () => Date): Promise<'done' | 'dropped' | 'retrying' | 'failed'> {
  const { db } = deps;
  const now = clock();
  const task = await asSystem(db, (trx) =>
    trx
      .selectFrom('visual_tasks as t')
      .innerJoin('posts as p', 'p.id', 't.post_id')
      .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .select(['t.instruction', 't.photo_mode', 't.attempts', 'p.workspace_id', 'p.account_id', 'p.status', 'p.scheduled_at', 'p.source_note', 'v.body'])
      .where('t.post_id', '=', postId)
      .executeTakeFirst(),
  );
  if (task === undefined) return 'dropped';
  const editable = (status: string) => (VISUAL_EDITABLE_STATUSES as readonly string[]).includes(status);
  if (!editable(task.status)) {
    await asSystem(db, (trx) => trx.deleteFrom('visual_tasks').where('post_id', '=', postId).execute());
    return 'dropped';
  }

  try {
    const previous = await asSystem(db, (trx) => loadPreviousVisual(trx, postId));
    const imagesForPost = await asSystem(db, (trx) => imagesGeneratedFor(trx, postId));
    const session = await openVisualSession({ db, model: deps.model, media: deps.media, images: deps.images ?? null, canva: deps.canva ?? null }, task.workspace_id, [task.account_id], now);
    const account = session?.accounts.get(task.account_id) as AccountVisual | undefined;
    if (session === null || account === undefined) throw new Error('Compte introuvable.');
    const withPhoto =
      task.photo_mode === 'new' ||
      (task.photo_mode === 'keep' && (previous !== null ? previous.photo !== null : (photoPlan(session, [{ accountId: task.account_id, at: task.scheduled_at }]).values().next().value ?? false)));
    const prepared = await prepareVisual(session.deps, session.ctx, account, {
      accountId: task.account_id,
      postText: task.body,
      summary: task.source_note ?? '',
      withPhoto,
      instruction: task.instruction,
      previous,
      newPhoto: task.photo_mode !== 'keep',
      imagesForPost,
      fallbackOnModelError: false,
    });
    if (prepared === null) throw new FinalError('Aucun modèle de visuel actif dans l’espace.');

    const stored = await asSystem(db, async (trx) => {
      // Le post a pu partir ou être remplacé pendant la préparation.
      const current = await trx.selectFrom('posts').select('status').where('id', '=', postId).forUpdate().executeTakeFirst();
      if (current === undefined || !editable(current.status)) {
        await trx.deleteFrom('visual_tasks').where('post_id', '=', postId).execute();
        return false;
      }
      await storeVisual(trx, prepared, { workspaceId: task.workspace_id, accountId: task.account_id, postId, runId: null, usdToEur: deps.usdToEur ?? 0.86, replacesAssetId: previous?.assetId ?? null }, clock());
      await trx.deleteFrom('visual_tasks').where('post_id', '=', postId).execute();
      return true;
    });
    return stored ? 'done' : 'dropped';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !(error instanceof FinalError) && (error instanceof ModelError ? error.retryable : true);
    const failed = !retryable || task.attempts >= VISUAL_TASK_MAX_ATTEMPTS;
    await asSystem(db, (trx) =>
      trx
        .updateTable('visual_tasks')
        .set({ lease_until: null, error: message, ...(failed && { failed_at: clock() }) })
        .where('post_id', '=', postId)
        .execute(),
    );
    return failed ? 'failed' : 'retrying';
  }
}

/** Erreur qu'un nouvel essai ne corrigera pas. */
class FinalError extends Error {}

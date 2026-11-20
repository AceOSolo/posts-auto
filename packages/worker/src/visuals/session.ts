/**
 * Visuels des posts rédigés par l'IA (rédaction hebdomadaire, demandes, reprises) :
 * contexte chargé une fois par passe, alternance photo / texte décidée compte par compte
 * dans l'ordre chronologique (VIS-04), préparation qui ne fait jamais échouer la rédaction :
 * un incident donne un post sans visuel, noté au rapport.
 */
import type { TextModel } from '@posts-auto/ai';
import { type Database, type Tx, asSystem } from '@posts-auto/db';
import { type ImageGenerator, photoTurns } from '@posts-auto/visuals';
import { sql } from 'kysely';
import type { MediaStore } from '../media/media-store.ts';
import {
  type AccountVisual,
  type CanvaRenderer,
  type PhotoSource,
  type PreparedVisual,
  type PreviousVisual,
  type VisualContext,
  type VisualDeps,
  type VisualRequest,
  loadAccountVisuals,
  loadVisualContext,
  prepareVisual,
} from './prepare.ts';

export interface VisualSession {
  readonly deps: VisualDeps;
  readonly ctx: VisualContext;
  readonly accounts: ReadonlyMap<string, AccountVisual>;
}

/** Ce que les tâches de rédaction transmettent : sans stockage des médias, pas de visuels. */
export interface VisualSource {
  readonly db: Database;
  readonly model: TextModel;
  readonly media?: MediaStore;
  readonly images?: ImageGenerator | null;
  /** VIS-07 : rendu des modèles de marque Canva. */
  readonly canva?: CanvaRenderer | null;
}

export async function openVisualSession(source: VisualSource, workspaceId: string, accountIds: readonly string[], now: Date): Promise<VisualSession | null> {
  const media = source.media;
  if (media === undefined) return null;
  return asSystem(source.db, async (trx) => ({
    deps: { model: source.model, media, images: source.images ?? null, canva: source.canva ?? null },
    ctx: await loadVisualContext(trx, media, workspaceId, now),
    accounts: await loadAccountVisuals(trx, accountIds, now),
  }));
}

/** VIS-04 : photo ou non pour chacun des posts à venir, compte par compte, dans l'ordre chronologique. */
export function photoPlan<T extends { readonly accountId: string; readonly at: Date }>(session: VisualSession, items: readonly T[]): Map<T, boolean> {
  const plan = new Map<T, boolean>();
  const byAccount = new Map<string, T[]>();
  for (const item of items) byAccount.set(item.accountId, [...(byAccount.get(item.accountId) ?? []), item]);
  for (const [accountId, list] of byAccount) {
    const account = session.accounts.get(accountId);
    const sorted = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
    const turns = photoTurns(account?.history ?? [], sorted.length, account?.ratio ?? 0.5);
    sorted.forEach((item, i) => plan.set(item, turns[i] ?? false));
  }
  return plan;
}

/** Résumé du visuel pour le rapport de rédaction. */
export interface VisualSummary {
  readonly made: boolean;
  readonly photo: PhotoSource | null;
  readonly issues: readonly string[];
  readonly notes: readonly string[];
}

export async function tryPrepareVisual(session: VisualSession, request: VisualRequest): Promise<{ prepared: PreparedVisual | null; summary: VisualSummary }> {
  const account = session.accounts.get(request.accountId);
  if (account === undefined) return { prepared: null, summary: { made: false, photo: null, issues: [], notes: ['Compte introuvable : pas de visuel.'] } };
  try {
    const prepared = await prepareVisual(session.deps, session.ctx, account, request);
    if (prepared === null) return { prepared, summary: { made: false, photo: null, issues: [], notes: ['Aucun modèle de visuel actif dans l’espace : pas de visuel.'] } };
    return {
      prepared,
      summary: { made: true, photo: prepared.content.photo, issues: prepared.content.issues.map((i) => `${i.code}:${i.zone}`), notes: prepared.content.notes },
    };
  } catch (error) {
    return { prepared: null, summary: { made: false, photo: null, issues: [], notes: [`Visuel non préparé : ${error instanceof Error ? error.message : String(error)}`] } };
  }
}

/** Visuel rendu d'un post (le premier dans l'ordre des images), avec sa recette. */
export async function loadPreviousVisual(trx: Tx, postId: string): Promise<PreviousVisual | null> {
  const row = await trx
    .selectFrom('post_media as pm')
    .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
    .leftJoin('media_assets as s', 's.id', 'm.source_asset_id')
    .select(['m.id', 'm.template_id', 'm.render_content', 's.id as photo_id', 's.storage_key as photo_key', 's.ai_generated as photo_ai'])
    .where('pm.post_id', '=', postId)
    .where('m.kind', '=', 'rendered')
    .orderBy('pm.position')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return null;
  const content = (row.render_content ?? {}) as { title?: unknown; bullets?: unknown };
  return {
    assetId: row.id,
    templateId: row.template_id,
    title: typeof content.title === 'string' ? content.title : '',
    bullets: Array.isArray(content.bullets) ? content.bullets.filter((b): b is string => typeof b === 'string') : [],
    photo: row.photo_id === null || row.photo_key === null ? null : { assetId: row.photo_id, storageKey: row.photo_key, aiGenerated: row.photo_ai === true },
  };
}

/** RÈG-19 : images déjà générées pour un post. */
export async function imagesGeneratedFor(trx: Tx, postId: string): Promise<number> {
  const row = await trx
    .selectFrom('ai_usage')
    .select(sql<number>`coalesce(sum(units), 0)::int`.as('n'))
    .where('post_id', '=', postId)
    .where('kind', '=', 'image')
    .executeTakeFirstOrThrow();
  return row.n;
}

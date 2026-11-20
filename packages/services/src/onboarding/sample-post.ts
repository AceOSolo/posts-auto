/**
 * Post d'exemple du démarrage : l'IA rédige un post à partir du site de l'entreprise, pour
 * montrer le résultat dès l'inscription, avant la connexion d'un compte LinkedIn. Il n'est
 * jamais publié ni compté comme post ; le dernier exemple remplace le précédent.
 */
import { type TextModel, costUsd, writeSamplePost } from '@posts-auto/ai';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { SafeFetchError } from '../net/safe-fetch.ts';
import { type PageFetcher, fetchPage, pageText } from './editorial-proposal.ts';

/** Chaque exemple coûte un appel à l'IA : 5 par espace et par heure. */
export const SAMPLE_POSTS_PER_HOUR = 5;

export interface SamplePost {
  readonly body: string;
  readonly summary: string;
  readonly sourceUrl: string;
  /** Consignes trouvées dans le site et ignorées. */
  readonly suspicious: readonly string[];
  readonly createdAt: Date;
}

export function parseSamplePost(value: unknown): SamplePost | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['body'] !== 'string' || typeof v['createdAt'] !== 'string') return null;
  return {
    body: v['body'],
    summary: typeof v['summary'] === 'string' ? v['summary'] : '',
    sourceUrl: typeof v['sourceUrl'] === 'string' ? v['sourceUrl'] : '',
    suspicious: Array.isArray(v['suspicious']) ? v['suspicious'].filter((s): s is string => typeof s === 'string') : [],
    createdAt: new Date(v['createdAt']),
  };
}

export async function writeSamplePostFor(
  db: Database,
  model: TextModel,
  userId: string,
  workspaceId: string,
  now: Date,
  options: { readonly fetcher?: PageFetcher; readonly usdToEur?: number } = {},
): Promise<SamplePost> {
  const { workspace, editorial } = await asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    if (!canManageContent(role)) throw new ForbiddenError('writeSamplePost');
    return {
      workspace: await trx.selectFrom('workspaces').select(['name', 'sector', 'website']).where('id', '=', workspaceId).executeTakeFirstOrThrow(),
      editorial: await trx.selectFrom('editorial_lines').select(['positioning', 'tone']).where('workspace_id', '=', workspaceId).where('is_current', '=', true).executeTakeFirst(),
    };
  });
  if (workspace.website === null) throw new RefusedError('site_requis', 'Indiquez d’abord le site de l’entreprise.');
  // Limite par espace, tous rôles confondus : lue sous l'identité système (journal d'audit).
  const recent = await asSystem(db, (trx) =>
    trx
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('action', '=', 'post_exemple.redige')
      .where('at', '>', new Date(now.getTime() - 3_600_000))
      .executeTakeFirstOrThrow(),
  );
  if (Number(recent.n) >= SAMPLE_POSTS_PER_HOUR) throw new RefusedError('trop_d_exemples', 'Trop d’exemples demandés : réessayez dans une heure.');

  let page: { url: string; text: string };
  try {
    const fetched = await (options.fetcher ?? fetchPage)(/^https?:\/\//i.test(workspace.website) ? workspace.website : `https://${workspace.website}`);
    page = { url: fetched.url, text: pageText(fetched.text) };
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error;
    throw new RefusedError('site_illisible', `Le site n’a pas pu être lu : ${error.message}`);
  }
  if (page.text.length < 50) throw new RefusedError('site_sans_texte', 'La page d’accueil du site ne contient presque pas de texte lisible.');

  const { draft, call } = await writeSamplePost(model, {
    companyName: workspace.name,
    sector: workspace.sector,
    editorial: editorial === undefined ? null : { positioning: editorial.positioning, tone: editorial.tone },
    pages: [page],
  });
  const sample: SamplePost = { body: draft.body, summary: draft.summary, sourceUrl: page.url, suspicious: draft.suspiciousInstructions, createdAt: now };
  const usd = costUsd(call.model, call.usage);
  await asSystem(db, async (trx) => {
    await trx.updateTable('workspaces').set({ sample_post: JSON.stringify(sample) }).where('id', '=', workspaceId).execute();
    await trx
      .insertInto('ai_usage')
      .values({
        workspace_id: workspaceId,
        provider: call.provider,
        model: call.model,
        purpose: 'write',
        kind: 'text',
        input_tokens: call.usage.inputTokens,
        output_tokens: call.usage.outputTokens,
        cache_read_tokens: call.usage.cacheReadTokens,
        cache_write_tokens: call.usage.cacheWriteTokens,
        cost_usd: usd.toFixed(6),
        cost_eur: (usd * (options.usdToEur ?? 0.86)).toFixed(6),
        counted_in_quota: false,
        at: now,
      })
      .execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'post_exemple.redige', entity: 'workspace', entityId: workspaceId, details: { site: page.url }, at: now });
  });
  return sample;
}

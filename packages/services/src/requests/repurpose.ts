/**
 * Déclinaison d'un article en idées de posts : la personne colle l'adresse d'un article,
 * l'IA en tire plusieurs angles distincts, chacun déposé comme idée (pour tous les comptes),
 * avec le lien de l'article. Les idées suivent ensuite leur chemin habituel : retenues ou
 * écartées par la gestion du contenu, reprises à la rédaction.
 */
import { type TextModel, costUsd, proposeAngles } from '@posts-auto/ai';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { canPropose, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { SafeFetchError } from '../net/safe-fetch.ts';
import { type PageFetcher, fetchPage, pageText } from '../onboarding/editorial-proposal.ts';
import { saveIdea } from './ideas-requests.ts';

/** Chaque déclinaison coûte un appel à l'IA : 10 par personne et par heure. */
export const REPURPOSES_PER_HOUR = 10;
export const REPURPOSE_ANGLES = 3;

export interface RepurposeOutcome {
  readonly ideaIds: readonly string[];
  /** Consignes trouvées dans l'article et ignorées. */
  readonly suspicious: readonly string[];
}

export async function ideasFromArticle(
  db: Database,
  model: TextModel,
  userId: string,
  workspaceId: string,
  rawUrl: string,
  now: Date,
  options: { readonly fetcher?: PageFetcher; readonly usdToEur?: number } = {},
): Promise<RepurposeOutcome> {
  const url = cleanText(rawUrl, 1000);
  if (url === null || !/^https?:\/\/\S+$/i.test(url)) throw new RefusedError('article_adresse', 'Collez l’adresse complète de l’article (https://…).');
  const workspace = await asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    if (!canPropose(role)) throw new ForbiddenError('proposeIdea');
    const ws = await trx.selectFrom('workspaces').select(['name', 'sector']).where('id', '=', workspaceId).executeTakeFirstOrThrow();
    const line = await trx.selectFrom('editorial_lines').select('positioning').where('workspace_id', '=', workspaceId).where('is_current', '=', true).executeTakeFirst();
    return { ...ws, positioning: line?.positioning ?? null };
  });
  const recent = await asSystem(db, (trx) =>
    trx
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('actor_user_id', '=', userId)
      .where('action', '=', 'idee.declinee')
      .where('at', '>', new Date(now.getTime() - 3_600_000))
      .executeTakeFirstOrThrow(),
  );
  if (Number(recent.n) >= REPURPOSES_PER_HOUR) throw new RefusedError('trop_de_declinaisons', 'Trop de déclinaisons demandées : réessayez dans une heure.');

  let article: { url: string; text: string };
  try {
    const page = await (options.fetcher ?? fetchPage)(url);
    article = { url: page.url, text: pageText(page.text) };
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error;
    throw new RefusedError('site_illisible', `L’article n’a pas pu être lu : ${error.message}`);
  }
  if (article.text.length < 200) throw new RefusedError('article_vide', 'La page ne contient pas assez de texte pour en tirer des posts.');

  const { angles, suspicious, call } = await proposeAngles(model, {
    companyName: workspace.name,
    sector: workspace.sector,
    positioning: workspace.positioning,
    article,
    count: REPURPOSE_ANGLES,
  });
  if (angles.length === 0) throw new RefusedError('article_sans_angle', 'L’IA n’a trouvé aucun angle de post dans cette page.');

  const ideaIds: string[] = [];
  for (const angle of angles) {
    ideaIds.push(await saveIdea(db, userId, workspaceId, null, { title: angle.title, details: `${angle.details}\n\nTiré de l’article : ${article.url}`, link: article.url, accountIds: [] }, now));
  }
  const usd = costUsd(call.model, call.usage);
  await asSystem(db, async (trx) => {
    await trx
      .insertInto('ai_usage')
      .values({
        workspace_id: workspaceId,
        provider: call.provider,
        model: call.model,
        purpose: 'interpret',
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
    await audit(trx, { workspaceId, actorUserId: userId, action: 'idee.declinee', entity: 'workspace', entityId: workspaceId, details: { article: article.url, ideas: ideaIds.length }, at: now });
  });
  return { ideaIds, suspicious };
}

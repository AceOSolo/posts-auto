/**
 * Ligne éditoriale proposée par l'IA (ONB-04), à partir du site web de l'entreprise et de
 * posts collés par la personne. La proposition n'est jamais enregistrée telle quelle : elle
 * pré-remplit le formulaire de la ligne éditoriale, que la personne corrige puis valide.
 *
 * Le site est lu par safeFetchText (protection contre l'accès au réseau interne). Une page
 * injoignable n'empêche pas la proposition si des posts ont été collés.
 */
import { type EditorialDraft, type TextModel, costUsd, proposeEditorialLine } from '@posts-auto/ai';
import { type Database, asSystem, asUser } from '@posts-auto/db';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { SafeFetchError, plainText, safeFetchText } from '../net/safe-fetch.ts';

/** Chaque proposition coûte un appel à l'IA : 10 par personne et par heure. */
export const EDITORIAL_PROPOSALS_PER_HOUR = 10;
const MAX_POSTS = 5;
const MAX_POST_CHARS = 3000;
const MAX_PAGE_CHARS = 8000;

export type PageFetcher = (url: string) => Promise<{ readonly text: string; readonly url: string }>;

export const fetchPage: PageFetcher = (url) => safeFetchText(url, { accept: 'text/html,application/xhtml+xml', userAgent: 'PostsLinkedIn-Demarrage/1.0', maxBytes: 1024 * 1024 });

export interface ProposalRequest {
  /** Site à lire ; à défaut, celui de l'espace. */
  readonly website?: string | null;
  /** Posts collés, séparés par une ligne « --- ». */
  readonly posts?: string | null;
}

export interface EditorialProposal extends EditorialDraft {
  /** Page effectivement lue. */
  readonly sourceUrl: string | null;
  /** Le site n'a pas pu être lu (la proposition repose alors sur les posts). */
  readonly websiteError: string | null;
}

/** Titre, description et texte visible d'une page HTML. */
export function pageText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const description = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1];
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return [title && plainText(title, 300), description && plainText(description, 500), plainText(body, MAX_PAGE_CHARS)].filter(Boolean).join('\n').slice(0, MAX_PAGE_CHARS);
}

export async function proposeEditorialLineFor(
  db: Database,
  model: TextModel,
  userId: string,
  workspaceId: string,
  request: ProposalRequest,
  now: Date,
  options: { readonly fetcher?: PageFetcher; readonly usdToEur?: number } = {},
): Promise<EditorialProposal> {
  const workspace = await asUser(db, userId, async (trx) => {
    const role = await workspaceRole(trx, userId, workspaceId);
    if (role === null) throw new NotFoundError('Espace');
    if (!canManageContent(role)) throw new ForbiddenError('proposeEditorialLine');
    const recent = await trx
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('actor_user_id', '=', userId)
      .where('action', '=', 'ligne.proposee')
      .where('at', '>', new Date(now.getTime() - 3_600_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= EDITORIAL_PROPOSALS_PER_HOUR) throw new RefusedError('trop_de_propositions', 'Trop de propositions demandées : réessayez dans une heure.');
    return trx.selectFrom('workspaces').select(['name', 'sector', 'website']).where('id', '=', workspaceId).executeTakeFirstOrThrow();
  });

  const posts = (request.posts ?? '')
    .split(/^\s*-{3,}\s*$/m)
    .map((p) => p.trim().slice(0, MAX_POST_CHARS))
    .filter((p) => p.length >= 20)
    .slice(0, MAX_POSTS);
  const website = cleanText(request.website, 300) ?? workspace.website;
  const pages: { url: string; text: string }[] = [];
  let websiteError: string | null = null;
  if (website !== null) {
    try {
      const page = await (options.fetcher ?? fetchPage)(/^https?:\/\//i.test(website) ? website : `https://${website}`);
      const text = pageText(page.text);
      if (text.length < 50) websiteError = 'La page d’accueil du site ne contient presque pas de texte lisible.';
      else pages.push({ url: page.url, text });
    } catch (error) {
      if (!(error instanceof SafeFetchError)) throw error;
      websiteError = `Le site n’a pas pu être lu : ${error.message}`;
    }
  }
  if (pages.length === 0 && posts.length === 0) {
    throw new RefusedError('proposition_vide', websiteError ?? 'Indiquez le site de l’entreprise ou collez quelques posts.');
  }

  const { draft, call } = await proposeEditorialLine(model, { companyName: workspace.name, sector: workspace.sector, pages, posts });
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
    await audit(trx, { workspaceId, actorUserId: userId, action: 'ligne.proposee', entity: 'workspace', entityId: workspaceId, details: { site: pages.length > 0, posts: posts.length }, at: now });
  });
  return { ...draft, sourceUrl: pages[0]?.url ?? null, websiteError };
}

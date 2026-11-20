/**
 * Statistiques LinkedIn (SUI-03), quand l'API les donne :
 * - post d'une page : GET /rest/organizationalEntityShareStatistics?q=organizationalEntity
 *   (impressions, réactions, commentaires, partages) ; permission r_organization_social ;
 * - post d'un profil : GET /rest/memberCreatorPostAnalytics?q=entity (un appel par mesure) ;
 *   permission r_member_postAnalytics ;
 * - abonnés d'une page : GET /rest/networkSizes/{urn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER.
 * Ces permissions relèvent de la Community Management API (section 8.2). Sans elles, ou si
 * LinkedIn ne répond pas, la statistique est « indisponible » : rien n'est inventé.
 */
import { LinkedInError } from './errors.ts';

export interface PostStats {
  readonly impressions: number | null;
  readonly reactions: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
}

export interface LinkedInStats {
  postStats(input: { readonly accessToken: string; readonly postUrn: string; readonly authorUrn: string }): Promise<PostStats | null>;
  followers(input: { readonly accessToken: string; readonly organizationUrn: string }): Promise<number | null>;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

export class LinkedInStatsClient implements LinkedInStats {
  readonly #apiVersion: string;
  readonly #fetch: typeof fetch;

  constructor(options: { readonly apiVersion: string; readonly fetch?: typeof fetch }) {
    this.#apiVersion = options.apiVersion;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Corps JSON, ou null si la statistique n'est pas accessible (permission, ressource). */
  async #get(url: string, accessToken: string): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, 'LinkedIn-Version': this.#apiVersion, 'X-Restli-Protocol-Version': '2.0.0' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new LinkedInError({ kind: 'network', phase: 'image_upload', outcome: 'not_created', status: null, message: `LinkedIn injoignable : ${error instanceof Error ? error.message : String(error)}` });
    }
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw new LinkedInError({ kind: 'server', phase: 'image_upload', outcome: 'not_created', status: response.status, message: `Statistiques illisibles (HTTP ${response.status})` });
    return (await response.json()) as Record<string, unknown>;
  }

  async postStats(input: { accessToken: string; postUrn: string; authorUrn: string }): Promise<PostStats | null> {
    const post = encodeURIComponent(input.postUrn);
    if (input.authorUrn.startsWith('urn:li:organization:')) {
      const key = input.postUrn.startsWith('urn:li:ugcPost:') ? 'ugcPosts' : 'shares';
      const body = await this.#get(
        `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(input.authorUrn)}&${key}=List(${post})`,
        input.accessToken,
      );
      const total = ((body?.['elements'] as Record<string, unknown>[] | undefined)?.[0]?.['totalShareStatistics'] ?? null) as Record<string, unknown> | null;
      if (total === null) return null;
      return { impressions: num(total['impressionCount']), reactions: num(total['likeCount']), comments: num(total['commentCount']), shares: num(total['shareCount']) };
    }
    const entity = input.postUrn.startsWith('urn:li:ugcPost:') ? `(ugc:${post})` : `(share:${post})`;
    const metric = async (queryType: string) => {
      const body = await this.#get(`https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=entity&entity=${entity}&queryType=${queryType}&aggregation=TOTAL`, input.accessToken);
      return body === null ? null : num((body['elements'] as Record<string, unknown>[] | undefined)?.[0]?.['count']);
    };
    const [impressions, reactions, comments, shares] = [await metric('IMPRESSION'), await metric('REACTION'), await metric('COMMENT'), await metric('RESHARE')];
    if (impressions === null && reactions === null && comments === null && shares === null) return null;
    return { impressions, reactions, comments, shares };
  }

  async followers(input: { accessToken: string; organizationUrn: string }): Promise<number | null> {
    const body = await this.#get(`https://api.linkedin.com/rest/networkSizes/${encodeURIComponent(input.organizationUrn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, input.accessToken);
    return body === null ? null : num(body['firstDegreeSize']);
  }
}

/** Statistiques simulées (développement, démonstration) : stables pour un même post. */
export class FakeLinkedInStats implements LinkedInStats {
  async postStats(input: { postUrn: string }): Promise<PostStats> {
    const seed = [...input.postUrn].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 100_000, 7);
    return { impressions: 300 + (seed % 2700), reactions: 5 + (seed % 60), comments: seed % 12, shares: seed % 5 };
  }

  async followers(input: { organizationUrn: string }): Promise<number> {
    return 500 + ([...input.organizationUrn].reduce((s, c) => s + c.charCodeAt(0), 0) % 1500);
  }
}

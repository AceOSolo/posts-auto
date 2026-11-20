/**
 * Pages d'entreprise administrées par la personne connectée (LNK-02), par la Community
 * Management API :
 * - GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED : pages dont
 *   la personne est administratrice ;
 * - GET /rest/organizations/{id} : nom de chaque page.
 * Permissions : w_organization_social (publier au nom de la page), r_organization_admin
 * (lire les rôles). Elles ne sont accordées qu'après validation de l'accès par LinkedIn
 * (section 8.2) : à vérifier avec l'application dès l'accès obtenu.
 */
import { LinkedInError } from './errors.ts';
import { PROFILE_SCOPES } from './oauth.ts';

export const PAGE_SCOPES = [...PROFILE_SCOPES, 'w_organization_social', 'r_organization_admin'] as const;
export const PAGE_PUBLISH_SCOPE = 'w_organization_social';
/** Au plus 50 pages lues par connexion. */
const MAX_PAGES = 50;

export interface AdministeredPage {
  readonly urn: string;
  readonly name: string;
  readonly vanityName: string | null;
}

export interface LinkedInPages {
  administeredPages(accessToken: string): Promise<AdministeredPage[]>;
}

const pagesError = (message: string, status: number | null = null) => new LinkedInError({ kind: 'auth', phase: 'image_upload', outcome: 'not_created', status, message });

export class LinkedInPagesClient implements LinkedInPages {
  readonly #apiVersion: string;
  readonly #fetch: typeof fetch;

  constructor(options: { readonly apiVersion: string; readonly fetch?: typeof fetch }) {
    this.#apiVersion = options.apiVersion;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #get(url: string, accessToken: string): Promise<Record<string, unknown>> {
    const response = await this.#fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, 'LinkedIn-Version': this.#apiVersion, 'X-Restli-Protocol-Version': '2.0.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) throw pagesError('LinkedIn refuse la lecture des pages : accès à la Community Management API requis.', response.status);
    if (!response.ok) throw pagesError(`Pages LinkedIn illisibles (HTTP ${response.status})`, response.status);
    return (await response.json()) as Record<string, unknown>;
  }

  async administeredPages(accessToken: string): Promise<AdministeredPage[]> {
    const acls = await this.#get('https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=100', accessToken);
    const urns = [
      ...new Set(
        (Array.isArray(acls['elements']) ? (acls['elements'] as Record<string, unknown>[]) : [])
          .map((e) => e['organization'])
          .filter((u): u is string => typeof u === 'string' && /^urn:li:organization:\d+$/.test(u)),
      ),
    ].slice(0, MAX_PAGES);
    const pages: AdministeredPage[] = [];
    for (const urn of urns) {
      const id = urn.slice('urn:li:organization:'.length);
      const org = await this.#get(`https://api.linkedin.com/rest/organizations/${id}`, accessToken);
      pages.push({
        urn,
        name: typeof org['localizedName'] === 'string' ? org['localizedName'] : `Page ${id}`,
        vanityName: typeof org['vanityName'] === 'string' ? org['vanityName'] : null,
      });
    }
    return pages;
  }
}

/** Pages simulées (développement, tests) : deux pages, propres au jeton. */
export class FakeLinkedInPages implements LinkedInPages {
  async administeredPages(accessToken: string): Promise<AdministeredPage[]> {
    const seed = accessToken.replace(/\W/g, '').slice(-6);
    return [
      { urn: `urn:li:organization:9${seed.length}${seed.charCodeAt(0) % 100}1`, name: 'Page de démonstration', vanityName: 'page-demo' },
      { urn: `urn:li:organization:9${seed.length}${seed.charCodeAt(0) % 100}2`, name: 'Filiale de démonstration', vanityName: null },
    ];
  }
}

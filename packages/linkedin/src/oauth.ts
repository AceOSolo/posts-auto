/**
 * Connexion d'un compte LinkedIn par OAuth 2.0 (LNK-01, CM-001 à CM-006).
 * Sources :
 * - https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
 * - https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
 *
 * Attention : l'identifiant d'un membre (« sub », type « pairwise ») est propre à chaque
 * application LinkedIn. Changer d'application change l'URN de tous les profils : d'où la
 * stratégie de garder l'application A et d'y ajouter la Community Management API (8.2).
 */
import { LinkedInError } from './errors.ts';

export const AUTHORIZATION_ENDPOINT = 'https://www.linkedin.com/oauth/v2/authorization';
export const TOKEN_ENDPOINT = 'https://www.linkedin.com/oauth/v2/accessToken';
export const USERINFO_ENDPOINT = 'https://api.linkedin.com/v2/userinfo';

/**
 * Permissions d'un profil : identité (openid, profile) et publication (w_member_social).
 * Pas de « email » : l'adresse n'est pas nécessaire (minimisation, section 10.2).
 */
export const PROFILE_SCOPES = ['openid', 'profile', 'w_member_social'] as const;

export interface TokenSet {
  readonly accessToken: string;
  readonly expiresAt: Date;
  readonly refreshToken: string | null;
  readonly refreshExpiresAt: Date | null;
  readonly scopes: readonly string[];
}

export interface MemberProfile {
  /** Identifiant du membre pour cette application LinkedIn. */
  readonly sub: string;
  readonly urn: string;
  readonly name: string;
  readonly pictureUrl: string | null;
}

export interface LinkedInOAuth {
  readonly clientId: string;
  authorizationUrl(state: string, scopes: readonly string[]): string;
  exchangeCode(code: string, now: Date): Promise<TokenSet>;
  refresh(refreshToken: string, now: Date): Promise<TokenSet>;
  memberProfile(accessToken: string): Promise<MemberProfile>;
}

export interface LinkedInOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetch?: typeof fetch;
}

const authError = (message: string, status: number | null = null) =>
  new LinkedInError({ kind: 'auth', phase: 'image_upload', outcome: 'not_created', status, message });

function toTokenSet(body: Record<string, unknown>, now: Date): TokenSet {
  if (typeof body['access_token'] !== 'string' || typeof body['expires_in'] !== 'number') {
    throw authError('Réponse inattendue de LinkedIn à l’échange du code');
  }
  const seconds = (key: string) => (typeof body[key] === 'number' ? (body[key] as number) : null);
  const refreshIn = seconds('refresh_token_expires_in');
  return {
    accessToken: body['access_token'],
    expiresAt: new Date(now.getTime() + body['expires_in'] * 1000),
    refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
    refreshExpiresAt: refreshIn === null ? null : new Date(now.getTime() + refreshIn * 1000),
    scopes: typeof body['scope'] === 'string' ? body['scope'].split(/[\s,]+/).filter(Boolean) : [],
  };
}

export class LinkedInOAuthClient implements LinkedInOAuth {
  readonly clientId: string;
  readonly #config: LinkedInOAuthConfig;
  readonly #fetch: typeof fetch;

  constructor(config: LinkedInOAuthConfig) {
    this.clientId = config.clientId;
    this.#config = config;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  authorizationUrl(state: string, scopes: readonly string[]): string {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.#config.clientId,
      redirect_uri: this.#config.redirectUri,
      state,
      scope: scopes.join(' '),
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string, now: Date): Promise<TokenSet> {
    return this.#token({ grant_type: 'authorization_code', code, redirect_uri: this.#config.redirectUri }, now);
  }

  async refresh(refreshToken: string, now: Date): Promise<TokenSet> {
    return this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken }, now);
  }

  async memberProfile(accessToken: string): Promise<MemberProfile> {
    const response = await this.#fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw authError(`Profil LinkedIn illisible (HTTP ${response.status})`, response.status);
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body['sub'] !== 'string' || body['sub'] === '') throw authError('Profil LinkedIn sans identifiant');
    return {
      sub: body['sub'],
      urn: `urn:li:person:${body['sub']}`,
      name: typeof body['name'] === 'string' ? body['name'] : 'Profil LinkedIn',
      pictureUrl: typeof body['picture'] === 'string' ? body['picture'] : null,
    };
  }

  async #token(params: Record<string, string>, now: Date): Promise<TokenSet> {
    const response = await this.#fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: this.#config.clientId, client_secret: this.#config.clientSecret }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const detail = typeof body['error_description'] === 'string' ? body['error_description'] : `HTTP ${response.status}`;
      throw authError(`LinkedIn a refusé la connexion : ${detail}`, response.status);
    }
    return toTokenSet(body, now);
  }
}

/** Photo du faux LinkedIn : un portrait stylisé, pour voir la carte du compte en recette. */
const FAKE_PICTURE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#2bb59a"/><circle cx="48" cy="37" r="18" fill="#fff4e2"/><path d="M14 96c3-24 17-36 34-36s31 12 34 36z" fill="#1e1a45"/></svg>',
)}`;

/**
 * Faux LinkedIn pour le développement et les tests : l'autorisation passe par un écran
 * simulé, voisin de l'adresse de retour, avec un code qui encode l'identité choisie.
 */
export class FakeLinkedInOAuth implements LinkedInOAuth {
  readonly clientId = 'fake-client';
  readonly #redirectUri: string;

  constructor(redirectUri: string) {
    this.#redirectUri = redirectUri;
  }

  authorizationUrl(state: string, scopes: readonly string[] = PROFILE_SCOPES): string {
    const url = new URL('simulation', this.#redirectUri);
    // Le code simulé garde la trace des permissions demandées (pages d'entreprise : LNK-02).
    url.searchParams.set('code', `fake-${scopes.includes('w_organization_social') ? 'p-' : ''}${state.slice(0, 12)}`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string, now: Date): Promise<TokenSet> {
    if (!code.startsWith('fake-')) throw authError('Code inconnu');
    const scopes = code.startsWith('fake-p-') ? [...PROFILE_SCOPES, 'w_organization_social', 'r_organization_admin'] : [...PROFILE_SCOPES];
    return { accessToken: `token-${code}`, expiresAt: new Date(now.getTime() + 60 * 86_400_000), refreshToken: null, refreshExpiresAt: null, scopes };
  }

  async refresh(): Promise<TokenSet> {
    throw authError('Pas de jeton de renouvellement en mode simulé');
  }

  async memberProfile(accessToken: string): Promise<MemberProfile> {
    const sub = `demo${accessToken.replace(/\W/g, '').slice(-10)}`;
    return { sub, urn: `urn:li:person:${sub}`, name: 'Profil de démonstration', pictureUrl: FAKE_PICTURE };
  }
}

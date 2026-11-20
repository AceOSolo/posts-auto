/**
 * ONB-01 : connexion avec Google ou Microsoft, en option à côté du lien par e-mail.
 *
 * - OpenID Connect, code d'autorisation avec PKCE et « state » ; le jeton d'identité est reçu
 *   directement du fournisseur (appel serveur à serveur en TLS), ce qui suffit à le croire
 *   (OpenID Connect Core, 3.1.3.7).
 * - Connexion seulement : l'adresse doit être celle d'un compte existant (inscription ou
 *   invitation) et **vérifiée** par le fournisseur (Google : email_verified ; Microsoft :
 *   xms_edov, propriétaire du domaine vérifié, revendication facultative à activer dans
 *   l'application Entra ID). Sinon, le lien par e-mail reste la voie.
 * - La double authentification (SEC-04) s'applique ensuite comme après un lien.
 * - Mode simulé (SSO_MODE=fake) : le fournisseur est remplacé par une page de l'application.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { type SessionGrant, normalizeEmail, openSession } from './auth.ts';

export type SsoProviderKey = 'google' | 'microsoft';

export interface SsoProvider {
  readonly key: SsoProviderKey;
  readonly label: string;
  authorizeUrl(input: { readonly state: string; readonly codeChallenge: string; readonly redirectUri: string; readonly loginHint?: string }): string;
  /** Adresse vérifiée de la personne, ou null si le fournisseur ne la garantit pas. */
  exchange(input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string }): Promise<{ readonly email: string | null; readonly subject: string }>;
}

export class SsoError extends Error {
  override readonly name = 'SsoError';
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function claimsOf(idToken: unknown): Record<string, unknown> {
  if (typeof idToken !== 'string') throw new SsoError('Jeton d’identité absent.');
  const payload = idToken.split('.')[1];
  if (payload === undefined) throw new SsoError('Jeton d’identité illisible.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

interface OidcConfig {
  readonly key: SsoProviderKey;
  readonly label: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly issuer: (claims: Record<string, unknown>) => boolean;
  readonly verifiedEmail: (claims: Record<string, unknown>) => string | null;
}

class OidcProvider implements SsoProvider {
  readonly key: SsoProviderKey;
  readonly label: string;
  readonly #config: OidcConfig;
  readonly #fetch: typeof fetch;

  constructor(config: OidcConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#config = config;
    this.key = config.key;
    this.label = config.label;
    this.#fetch = fetchImpl;
  }

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string {
    const params = new URLSearchParams({
      client_id: this.#config.clientId,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      scope: 'openid email profile',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      ...(input.loginHint && { login_hint: input.loginHint }),
    });
    return `${this.#config.authorizeEndpoint}?${params.toString()}`;
  }

  async exchange(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ email: string | null; subject: string }> {
    const response = await this.#fetch(this.#config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        code_verifier: input.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new SsoError(`${this.label} injoignable : ${error instanceof Error ? error.message : String(error)}`);
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new SsoError(`${this.label} a refusé la connexion (HTTP ${response.status}).`);
    const claims = claimsOf(body['id_token']);
    if (claims['aud'] !== this.#config.clientId || !this.#config.issuer(claims)) throw new SsoError('Jeton d’identité destiné à une autre application.');
    if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 < Date.now()) throw new SsoError('Jeton d’identité expiré.');
    return { email: this.#config.verifiedEmail(claims), subject: String(claims['sub'] ?? '') };
  }
}

export function googleProvider(clientId: string, clientSecret: string, fetchImpl?: typeof fetch): SsoProvider {
  return new OidcProvider(
    {
      key: 'google',
      label: 'Google',
      clientId,
      clientSecret,
      authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      issuer: (c) => c['iss'] === 'https://accounts.google.com' || c['iss'] === 'accounts.google.com',
      verifiedEmail: (c) => (c['email_verified'] === true && typeof c['email'] === 'string' ? c['email'] : null),
    },
    fetchImpl,
  );
}

export function microsoftProvider(clientId: string, clientSecret: string, fetchImpl?: typeof fetch): SsoProvider {
  return new OidcProvider(
    {
      key: 'microsoft',
      label: 'Microsoft',
      clientId,
      clientSecret,
      authorizeEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      issuer: (c) => typeof c['iss'] === 'string' && /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(c['iss']),
      // Microsoft ne garantit l'adresse que si le domaine est vérifié par le client (xms_edov).
      verifiedEmail: (c) => (c['xms_edov'] === true && typeof c['email'] === 'string' ? c['email'] : null),
    },
    fetchImpl,
  );
}

/** Fournisseur simulé : le « code » porte l'adresse (développement et test de fumée seulement). */
export class FakeSsoProvider implements SsoProvider {
  readonly label: string;
  constructor(
    readonly key: SsoProviderKey,
    readonly appUrl: string,
  ) {
    this.label = key === 'google' ? 'Google' : 'Microsoft';
  }
  authorizeUrl(input: { state: string; redirectUri: string; loginHint?: string }): string {
    const params = new URLSearchParams({ state: input.state, retour: input.redirectUri, fournisseur: this.key });
    return `${this.appUrl}/connexion/sso/simulation?${params.toString()}`;
  }
  async exchange(input: { code: string }): Promise<{ email: string | null; subject: string }> {
    if (!input.code.startsWith('fake-')) throw new SsoError('Code simulé invalide.');
    const email = input.code.slice(5);
    return { email: email.startsWith('nonverifie:') ? null : email, subject: `fake-${email}` };
  }
}

export type SsoOutcome = { readonly ok: true; readonly session: SessionGrant } | { readonly ok: false; readonly reason: 'adresse_non_verifiee' | 'compte_inconnu' };

/** Ouvre une session pour l'adresse vérifiée par le fournisseur, si elle a un compte. */
export async function completeSsoLogin(db: Database, identity: { readonly email: string | null }, now: Date, meta: { ip?: string; userAgent?: string } = {}): Promise<SsoOutcome> {
  if (identity.email === null) return { ok: false, reason: 'adresse_non_verifiee' };
  const email = normalizeEmail(identity.email);
  if (email === null) return { ok: false, reason: 'adresse_non_verifiee' };
  return asSystem(db, async (trx) => {
    const user = await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (user === undefined) return { ok: false, reason: 'compte_inconnu' };
    return { ok: true, session: await openSession(trx, user.id, now, meta) };
  });
}

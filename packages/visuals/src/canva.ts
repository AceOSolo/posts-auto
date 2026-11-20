/**
 * VIS-07 : connecteur Canva (API Canva Connect), avec l'autorisation du client (OAuth 2 avec
 * PKCE). Les designs restent dans le Canva du client :
 * 1. l'espace choisit des modèles de marque Canva (brand templates) et relie leurs champs
 *    (texte, image) aux zones du visuel : titre, sous-titre, points, photo, signature ;
 * 2. pour un post, Canva crée une copie du modèle remplie (autofill), la photo étant d'abord
 *    envoyée dans les fichiers Canva du client ;
 * 3. la copie est exportée en PNG et rapatriée comme visuel du post.
 * Les modèles de marque et l'autofill demandent un abonnement Canva qui les propose (Canva
 * Teams ou Enterprise, selon l'offre Canva en vigueur).
 */

export const CANVA_SCOPES = ['design:content:read', 'design:content:write', 'design:meta:read', 'asset:write', 'brandtemplate:meta:read', 'brandtemplate:content:read'] as const;

export interface CanvaTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

export interface CanvaBrandTemplate {
  readonly id: string;
  readonly title: string;
}

export type CanvaFieldType = 'text' | 'image';

export interface CanvaAutofillData {
  readonly [field: string]: { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly assetId: string };
}

export interface CanvaApi {
  authorizeUrl(input: { readonly state: string; readonly codeChallenge: string; readonly redirectUri: string }): string;
  exchangeCode(input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string }, now: Date): Promise<CanvaTokens>;
  refresh(refreshToken: string, now: Date): Promise<CanvaTokens>;
  brandTemplates(accessToken: string): Promise<CanvaBrandTemplate[]>;
  dataset(accessToken: string, brandTemplateId: string): Promise<Record<string, CanvaFieldType>>;
  uploadImage(accessToken: string, name: string, bytes: Uint8Array): Promise<string>;
  /** Copie remplie du modèle (dans le Canva du client), exportée en PNG. */
  renderPng(accessToken: string, brandTemplateId: string, title: string, data: CanvaAutofillData): Promise<{ readonly png: Uint8Array; readonly designId: string }>;
}

export class CanvaError extends Error {
  override readonly name = 'CanvaError';
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const API = 'https://api.canva.com/rest/v1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CanvaConnectClient implements CanvaApi {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;

  constructor(options: { readonly clientId: string; readonly clientSecret: string; readonly fetch?: typeof fetch; readonly pollMs?: number }) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pollMs = options.pollMs ?? 1500;
  }

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.#clientId,
      redirect_uri: input.redirectUri,
      scope: CANVA_SCOPES.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 's256',
    });
    return `https://www.canva.com/api/oauth/authorize?${params.toString()}`;
  }

  async #token(body: Record<string, string>, now: Date): Promise<CanvaTokens> {
    const response = await this.#fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new CanvaError(`Canva injoignable : ${error instanceof Error ? error.message : String(error)}`, true);
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof json['access_token'] !== 'string') throw new CanvaError(`Canva a refusé l’autorisation (HTTP ${response.status}).`, response.status >= 500);
    return {
      accessToken: json['access_token'],
      refreshToken: String(json['refresh_token'] ?? ''),
      expiresAt: new Date(now.getTime() + (Number(json['expires_in']) || 14_400) * 1000),
    };
  }

  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }, now: Date): Promise<CanvaTokens> {
    return this.#token({ grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri }, now);
  }

  refresh(refreshToken: string, now: Date): Promise<CanvaTokens> {
    return this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken }, now);
  }

  async #call(method: 'GET' | 'POST', path: string, accessToken: string, body?: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body !== undefined && !(body instanceof Uint8Array) && { 'content-type': 'application/json' }), ...headers },
      ...(body !== undefined && { body: body instanceof Uint8Array ? new Blob([Buffer.from(body)]) : JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => {
      throw new CanvaError(`Canva injoignable : ${error instanceof Error ? error.message : String(error)}`, true);
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = (json['message'] as string | undefined) ?? `HTTP ${response.status}`;
      throw new CanvaError(`Canva : ${message}`, response.status === 429 || response.status >= 500);
    }
    return json;
  }

  /** Attend la fin d'une tâche Canva (envoi, remplissage, export), 60 secondes au plus. */
  async #job(path: string, accessToken: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 40; i += 1) {
      const job = ((await this.#call('GET', path, accessToken))['job'] ?? {}) as Record<string, unknown>;
      if (job['status'] === 'success') return job;
      if (job['status'] === 'failed') throw new CanvaError(`Canva : tâche en échec (${String((job['error'] as { message?: string } | undefined)?.message ?? 'inconnue')}).`, false);
      await sleep(this.#pollMs);
    }
    throw new CanvaError('Canva : tâche trop longue.', true);
  }

  async brandTemplates(accessToken: string): Promise<CanvaBrandTemplate[]> {
    const json = await this.#call('GET', '/brand-templates?limit=100', accessToken);
    return ((json['items'] as Record<string, unknown>[] | undefined) ?? []).map((t) => ({ id: String(t['id']), title: String(t['title'] ?? 'Modèle Canva') }));
  }

  async dataset(accessToken: string, brandTemplateId: string): Promise<Record<string, CanvaFieldType>> {
    const json = await this.#call('GET', `/brand-templates/${encodeURIComponent(brandTemplateId)}/dataset`, accessToken);
    const fields: Record<string, CanvaFieldType> = {};
    for (const [name, def] of Object.entries((json['dataset'] ?? {}) as Record<string, { type?: string }>)) {
      if (def.type === 'text' || def.type === 'image') fields[name] = def.type;
    }
    return fields;
  }

  async uploadImage(accessToken: string, name: string, bytes: Uint8Array): Promise<string> {
    const started = await this.#call('POST', '/asset-uploads', accessToken, bytes, {
      'content-type': 'application/octet-stream',
      'asset-upload-metadata': JSON.stringify({ name_base64: Buffer.from(name).toString('base64') }),
    });
    const id = String((started['job'] as { id?: string } | undefined)?.id ?? '');
    const job = await this.#job(`/asset-uploads/${encodeURIComponent(id)}`, accessToken);
    return String((job['asset'] as { id?: string } | undefined)?.id ?? '');
  }

  async renderPng(accessToken: string, brandTemplateId: string, title: string, data: CanvaAutofillData): Promise<{ png: Uint8Array; designId: string }> {
    const payload = Object.fromEntries(Object.entries(data).map(([field, value]) => [field, value.type === 'text' ? { type: 'text', text: value.text } : { type: 'image', asset_id: value.assetId }]));
    const autofill = await this.#call('POST', '/autofills', accessToken, { brand_template_id: brandTemplateId, title: title.slice(0, 255), data: payload });
    const filled = await this.#job(`/autofills/${encodeURIComponent(String((autofill['job'] as { id?: string } | undefined)?.id ?? ''))}`, accessToken);
    const designId = String(((filled['result'] as { design?: { id?: string } } | undefined)?.design?.id) ?? '');
    const exported = await this.#call('POST', '/exports', accessToken, { design_id: designId, format: { type: 'png' } });
    const done = await this.#job(`/exports/${encodeURIComponent(String((exported['job'] as { id?: string } | undefined)?.id ?? ''))}`, accessToken);
    const url = ((done['urls'] as string[] | undefined) ?? [])[0];
    if (!url) throw new CanvaError('Canva : export sans fichier.', true);
    const file = await this.#fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!file.ok) throw new CanvaError(`Canva : export illisible (HTTP ${file.status}).`, true);
    return { png: new Uint8Array(await file.arrayBuffer()), designId };
  }
}

/** Zones du visuel reliées aux champs d'un modèle de marque Canva. */
export interface CanvaFieldMap {
  readonly title?: string;
  readonly subtitle?: string;
  readonly bullets?: string;
  readonly signature?: string;
  readonly photo?: string;
}

/** Rapproche les champs d'un modèle Canva des zones du visuel, d'après leur nom. */
export function guessCanvaFieldMap(dataset: Record<string, CanvaFieldType>): CanvaFieldMap {
  const texts = Object.entries(dataset).filter(([, t]) => t === 'text').map(([n]) => n);
  const images = Object.entries(dataset).filter(([, t]) => t === 'image').map(([n]) => n);
  const find = (pattern: RegExp) => texts.find((n) => pattern.test(n));
  const title = find(/titre|title|headline|accroche/i) ?? texts[0];
  const subtitle = find(/sous[-_ ]?titre|subtitle|chapo/i);
  const bullets = find(/point|bullet|liste|list/i);
  const signature = find(/signature|auteur|author|nom|name/i);
  const photo = images.find((n) => /photo|image|visuel|picture/i.test(n)) ?? images[0];
  return {
    ...(title !== undefined && { title }),
    ...(subtitle !== undefined && subtitle !== title && { subtitle }),
    ...(bullets !== undefined && bullets !== title && { bullets }),
    ...(signature !== undefined && signature !== title && { signature }),
    ...(photo !== undefined && { photo }),
  };
}

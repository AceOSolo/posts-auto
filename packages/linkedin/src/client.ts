/**
 * Publication d'un post sur LinkedIn (API Posts et API Images, versionnées).
 * Sources :
 * - https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * - https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * - https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
 */
import { LinkedInError, type LinkedInPhase, errorFromNetwork, errorFromResponse } from './errors.ts';
import { type LittleTextOptions, toLittleText } from './little-text.ts';

/** Formats acceptés par l'API Images. */
export type LinkedInImageMime = 'image/png' | 'image/jpeg' | 'image/gif';

export interface PublishImage {
  readonly bytes: Uint8Array;
  readonly mime: LinkedInImageMime;
  readonly altText?: string;
}

export interface PublishRequest {
  /** urn:li:person:… (profil) ou urn:li:organization:… (page). */
  readonly authorUrn: string;
  /** Texte brut du post ; l'échappement au format little est fait ici. */
  readonly text: string;
  /** Dans l'ordre d'affichage ; la première est la couverture. */
  readonly images: readonly PublishImage[];
  readonly textOptions?: LittleTextOptions;
  /** VIS-10 : carrousel (document PDF) ; remplace les images. */
  readonly document?: { readonly bytes: Uint8Array; readonly title: string };
}

export interface PublishedPost {
  readonly postUrn: string;
  readonly url: string;
}

/** Ce dont la file de publication a besoin. Lève une LinkedInError en cas d'échec. */
export interface LinkedInPublisher {
  publish(accessToken: string, request: PublishRequest): Promise<PublishedPost>;
  /** PUB-07 : premier commentaire sous le post, au nom de son auteur (profil ou page). */
  comment?(accessToken: string, request: { readonly postUrn: string; readonly actorUrn: string; readonly text: string }): Promise<void>;
}

export const LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';
/** Limites de l'API : au moins 2 images pour un post multi-images, au plus 20. */
export const MAX_IMAGES_PER_POST = 20;
export const MAX_COMMENTARY_LENGTH = 3000;

export function postUrl(postUrn: string): string {
  return `https://www.linkedin.com/feed/update/${postUrn}/`;
}

export interface LinkedInHttpClientOptions {
  /** Version de l'API au format AAAAMM (en-tête LinkedIn-Version), à monter avant chaque retrait. */
  readonly apiVersion: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

export class LinkedInHttpClient implements LinkedInPublisher {
  readonly #apiVersion: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;

  constructor(options: LinkedInHttpClientOptions) {
    if (!/^\d{6}$/.test(options.apiVersion)) throw new Error('apiVersion doit être au format AAAAMM');
    this.#apiVersion = options.apiVersion;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#baseUrl = options.baseUrl ?? LINKEDIN_API_BASE;
  }

  async publish(accessToken: string, request: PublishRequest): Promise<PublishedPost> {
    validate(request);
    const imageIds: { id: string; altText?: string }[] = [];
    for (const image of request.images) {
      const id = await this.#uploadImage(accessToken, request.authorUrn, image);
      imageIds.push(image.altText === undefined ? { id } : { id, altText: image.altText });
    }

    const body: Record<string, unknown> = {
      author: request.authorUrn,
      commentary: toLittleText(request.text, request.textOptions),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (imageIds.length === 1) body['content'] = { media: imageIds[0] };
    if (imageIds.length > 1) body['content'] = { multiImage: { images: imageIds } };
    if (request.document !== undefined) body['content'] = { media: { id: await this.#uploadDocument(accessToken, request.authorUrn, request.document.bytes), title: request.document.title.slice(0, 200) } };

    const response = await this.#call('post_create', `${this.#baseUrl}/posts`, {
      method: 'POST',
      headers: this.#headers(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const postUrn = response.headers.get('x-restli-id');
    if (postUrn === null || !postUrn.startsWith('urn:li:')) {
      // Réponse 2xx sans identifiant : le post existe probablement, mais on ne sait pas lequel.
      throw new LinkedInError({
        kind: 'server',
        phase: 'post_create',
        outcome: 'unknown',
        status: response.status,
        message: 'LinkedIn a répondu sans identifiant de post',
      });
    }
    return { postUrn, url: postUrl(postUrn) };
  }

  /** PUB-07 : POST /rest/socialActions/{post}/comments (w_member_social ou w_organization_social). */
  async comment(accessToken: string, request: { postUrn: string; actorUrn: string; text: string }): Promise<void> {
    await this.#call('post_create', `${this.#baseUrl}/socialActions/${encodeURIComponent(request.postUrn)}/comments`, {
      method: 'POST',
      headers: this.#headers(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ actor: request.actorUrn, object: request.postUrn, message: { text: request.text } }),
    });
  }

  /** VIS-10 : POST /rest/documents?action=initializeUpload, puis envoi du PDF. */
  async #uploadDocument(accessToken: string, ownerUrn: string, bytes: Uint8Array): Promise<string> {
    const init = await this.#call('image_upload', `${this.#baseUrl}/documents?action=initializeUpload`, {
      method: 'POST',
      headers: this.#headers(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    });
    const value = ((await init.json()) as { value?: { uploadUrl?: unknown; document?: unknown } }).value;
    if (typeof value?.uploadUrl !== 'string' || typeof value.document !== 'string') {
      throw new LinkedInError({ kind: 'server', phase: 'image_upload', outcome: 'not_created', status: init.status, message: 'Réponse inattendue de LinkedIn à la préparation de l’envoi du document' });
    }
    await this.#call('image_upload', value.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes) });
    return value.document;
  }

  async #uploadImage(accessToken: string, ownerUrn: string, image: PublishImage): Promise<string> {
    const init = await this.#call('image_upload', `${this.#baseUrl}/images?action=initializeUpload`, {
      method: 'POST',
      headers: this.#headers(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    });
    const value = ((await init.json()) as { value?: { uploadUrl?: unknown; image?: unknown } }).value;
    if (typeof value?.uploadUrl !== 'string' || typeof value.image !== 'string') {
      throw new LinkedInError({
        kind: 'server',
        phase: 'image_upload',
        outcome: 'not_created',
        status: init.status,
        message: 'Réponse inattendue de LinkedIn à la préparation de l’envoi d’image',
      });
    }
    await this.#call('image_upload', value.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': image.mime },
      // Copie dans un ArrayBuffer simple : fetch n'accepte pas un tampon partagé de Node.
      body: new Uint8Array(image.bytes),
    });
    return value.image;
  }

  #headers(accessToken: string, extra: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': this.#apiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
      ...extra,
    };
  }

  async #call(phase: LinkedInPhase, url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      throw errorFromNetwork(phase, error);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      throw errorFromResponse(phase, response.status, body);
    }
    return response;
  }
}

function validate(request: PublishRequest): void {
  const reject = (message: string) =>
    new LinkedInError({ kind: 'invalid', phase: 'image_upload', outcome: 'not_created', message });
  if (!/^urn:li:(person|organization):[\w-]+$/.test(request.authorUrn)) throw reject('Auteur LinkedIn invalide');
  if (request.text.trim().length === 0) throw reject('Le texte du post est vide');
  if (request.text.length > MAX_COMMENTARY_LENGTH) throw reject(`Le texte dépasse ${MAX_COMMENTARY_LENGTH} caractères`);
  if (request.images.length > MAX_IMAGES_PER_POST) throw reject(`Au plus ${MAX_IMAGES_PER_POST} images par post`);
  if (request.document !== undefined && request.images.length > 0) throw reject('Un carrousel PDF ne s’accompagne pas d’images');
  if (request.document !== undefined && request.document.bytes.length > 100 * 1024 * 1024) throw reject('Document de plus de 100 Mo');
}

/**
 * Connecteur Higgsfield (VIS-05, section 8.3) : images fixes seulement.
 *
 * Écrit d'après la documentation publique de l'API (docs.higgsfield.ai, consultée le
 * 13/11/2026) ; à vérifier avec une vraie clé avant la mise en service :
 * - soumission : POST {base}/{modèle}, en-tête « Authorization: Key {id}:{secret} »,
 *   corps JSON propre au modèle (prompt, aspect_ratio…), en-tête Idempotency-Key ;
 * - réponse : { status: "queued", request_id, status_url, cancel_url } ;
 * - suivi : GET status_url jusqu'à « completed » (images[].url), ou « failed », « nsfw »
 *   (refusé par la modération), « canceled » ; les fichiers restent 7 jours.
 *
 * L'image est téléchargée aussitôt et convertie en JPEG si son format n'est pas accepté
 * par LinkedIn (PNG, JPEG, GIF). Le modèle par défaut est SOUL Standard, dont les
 * paramètres sont documentés ; un autre modèle ne reçoit que prompt et aspect_ratio.
 */
import { randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { type GeneratedImage, type ImageGenerator, type ImageRequest, imagePrompt } from './image-generator.ts';

export const HIGGSFIELD_BASE_URL = 'https://api.higgsfield.ai';
export const HIGGSFIELD_DEFAULT_MODEL = 'higgsfield-ai/soul/standard';
/** Proportions acceptées par SOUL. */
export const HIGGSFIELD_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface HiggsfieldOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** Coût d'une image en dollars, s'il est connu (GEN-11). */
  readonly costUsd?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  /** Pour les tests. */
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Erreur du générateur ; `retryable` : un nouvel essai plus tard peut réussir. */
export class ImageGenerationError extends Error {
  override readonly name = 'ImageGenerationError';
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/** Proportion acceptée la plus proche de la zone photo du modèle. */
export function nearestAspect(width: number, height: number): (typeof HIGGSFIELD_ASPECTS)[number] {
  const target = Math.log(width / height);
  let best: (typeof HIGGSFIELD_ASPECTS)[number] = '1:1';
  let distance = Number.POSITIVE_INFINITY;
  for (const aspect of HIGGSFIELD_ASPECTS) {
    const [w, h] = aspect.split(':').map(Number) as [number, number];
    const d = Math.abs(Math.log(w / h) - target);
    if (d < distance) {
      distance = d;
      best = aspect;
    }
  }
  return best;
}

function httpError(status: number, detail: string): ImageGenerationError {
  if (status === 401 || status === 403) return new ImageGenerationError(`clé Higgsfield refusée (HTTP ${status})`, false);
  if (status === 402) return new ImageGenerationError('crédits Higgsfield épuisés (HTTP 402)', false);
  if (status === 400 || status === 422) return new ImageGenerationError(`demande refusée par Higgsfield (HTTP ${status}) : ${detail.slice(0, 200)}`, false);
  return new ImageGenerationError(`Higgsfield indisponible (HTTP ${status})`, true);
}

type Mime = 'image/png' | 'image/jpeg';

function signature(bytes: Uint8Array): Mime | 'image/gif' | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return null;
}

/** PNG et JPEG gardés tels quels ; tout autre format (WebP…) converti en JPEG. */
async function normalize(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mime: Mime }> {
  const kind = signature(bytes);
  if (kind === 'image/png' || kind === 'image/jpeg') return { bytes, mime: kind };
  const image = await loadImage(Buffer.from(bytes)).catch(() => null);
  if (image === null) throw new ImageGenerationError('image reçue illisible', true);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return { bytes: new Uint8Array(await canvas.encode('jpeg', 90)), mime: 'image/jpeg' };
}

export class HiggsfieldImageGenerator implements ImageGenerator {
  readonly provider = 'higgsfield';
  readonly model: string;
  readonly #options: HiggsfieldOptions;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: HiggsfieldOptions) {
    this.#options = options;
    this.model = options.model ?? HIGGSFIELD_DEFAULT_MODEL;
    this.#base = (options.baseUrl ?? HIGGSFIELD_BASE_URL).replace(/\/$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  #headers(): Record<string, string> {
    return { Authorization: `Key ${this.#options.keyId}:${this.#options.keySecret}`, Accept: 'application/json' };
  }

  /** Seules les adresses de l'API sont suivies (pas d'adresse arbitraire renvoyée par une réponse). */
  #statusUrl(raw: unknown, requestId: string): string {
    if (typeof raw === 'string' && raw.startsWith(`${this.#base}/`)) return raw;
    return `${this.#base}/requests/${encodeURIComponent(requestId)}/status`;
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const prompt = imagePrompt(request.subject);
    const aspect = nearestAspect(request.width, request.height);
    const body = this.model.startsWith('higgsfield-ai/soul')
      ? { prompt, aspect_ratio: aspect, resolution: '1080p', batch_size: 1, enhance_prompt: false }
      : { prompt, aspect_ratio: aspect };

    const submitted = await this.#fetch(`${this.#base}/${this.model}`, {
      method: 'POST',
      headers: { ...this.#headers(), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => {
      throw new ImageGenerationError(`Higgsfield injoignable (${error instanceof Error ? error.message : String(error)})`, true);
    });
    if (!submitted.ok) throw httpError(submitted.status, await submitted.text().catch(() => ''));
    const handle = (await submitted.json()) as { request_id?: unknown; status_url?: unknown };
    if (typeof handle.request_id !== 'string') throw new ImageGenerationError('réponse de Higgsfield sans identifiant de demande', true);
    const statusUrl = this.#statusUrl(handle.status_url, handle.request_id);

    const deadline = Date.now() + (this.#options.timeoutMs ?? 180_000);
    let imageUrl: string | null = null;
    while (imageUrl === null) {
      const response = await this.#fetch(statusUrl, { headers: this.#headers(), signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (response !== null && !response.ok && response.status !== 429 && response.status < 500) throw httpError(response.status, await response.text().catch(() => ''));
      const state = response?.ok ? ((await response.json()) as { status?: unknown; images?: { url?: unknown }[]; error?: unknown }) : null;
      switch (state?.status) {
        case 'completed': {
          const url = state.images?.[0]?.url;
          if (typeof url !== 'string' || !url.startsWith('https://')) throw new ImageGenerationError('image terminée sans adresse', true);
          imageUrl = url;
          break;
        }
        case 'failed':
          throw new ImageGenerationError(`génération échouée${typeof state.error === 'string' ? ` : ${state.error.slice(0, 200)}` : ''}`, true);
        case 'nsfw':
          throw new ImageGenerationError('image refusée par la modération de Higgsfield', false);
        case 'canceled':
          throw new ImageGenerationError('génération annulée', true);
        default:
          if (Date.now() >= deadline) throw new ImageGenerationError('génération trop longue : abandonnée', true);
          await this.#sleep(this.#options.pollIntervalMs ?? 3_000);
      }
    }

    const download = await this.#fetch(imageUrl, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (download === null || !download.ok) throw new ImageGenerationError('téléchargement de l’image impossible', true);
    const raw = new Uint8Array(await download.arrayBuffer());
    if (raw.length === 0 || raw.length > MAX_IMAGE_BYTES) throw new ImageGenerationError('image reçue vide ou trop lourde', false);
    const image = await normalize(raw);
    return { ...image, provider: this.provider, model: this.model, prompt, costUsd: this.#options.costUsd ?? 0 };
  }
}

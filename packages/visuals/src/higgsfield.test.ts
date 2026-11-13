import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { imageGeneratorFromEnv } from './generators.ts';
import { HIGGSFIELD_BASE_URL, HiggsfieldImageGenerator, ImageGenerationError, nearestAspect } from './higgsfield.ts';
import { FakeImageGenerator, IMAGE_RULES } from './image-generator.ts';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

async function encoded(format: 'png' | 'webp'): Promise<Uint8Array> {
  const canvas = createCanvas(64, 48);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#336699';
  ctx.fillRect(0, 0, 64, 48);
  return new Uint8Array(format === 'png' ? await canvas.encode('png') : await canvas.encode('webp'));
}

/** Faux Higgsfield : soumission, puis les états donnés à chaque suivi, puis le fichier. */
function fakeApi(states: readonly unknown[], options: { submitStatus?: number; file?: Uint8Array } = {}) {
  const calls: Call[] = [];
  let poll = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (init?.method === 'POST') {
      if (options.submitStatus) return new Response('{"detail":"refusé"}', { status: options.submitStatus });
      return Response.json({ status: 'queued', request_id: 'req-1', status_url: `${HIGGSFIELD_BASE_URL}/requests/req-1/status`, cancel_url: `${HIGGSFIELD_BASE_URL}/requests/req-1/cancel` });
    }
    if (url.endsWith('/status')) {
      const state = states[Math.min(poll, states.length - 1)];
      poll += 1;
      return Response.json(state);
    }
    return new Response(Buffer.from(options.file ?? (await encoded('png'))), { headers: { 'Content-Type': 'image/png' } });
  }) as typeof fetch;
  const generator = new HiggsfieldImageGenerator({ keyId: 'id', keySecret: 'secret', costUsd: 0.04, fetch: fetcher, sleep: async () => undefined, pollIntervalMs: 1 });
  return { generator, calls };
}

const completed = { status: 'completed', request_id: 'req-1', images: [{ url: 'https://cdn.example.com/image-1.png' }] };

describe('connecteur Higgsfield (VIS-05)', () => {
  it('soumet la consigne avec les règles, suit la demande, télécharge l’image', async () => {
    const { generator, calls } = fakeApi([{ status: 'queued' }, { status: 'in_progress' }, completed]);
    const image = await generator.generate({ subject: 'Atelier de menuiserie lumineux', width: 1080, height: 640 });
    expect(image).toMatchObject({ mime: 'image/png', provider: 'higgsfield', model: 'higgsfield-ai/soul/standard', costUsd: 0.04 });
    expect(image.prompt).toBe(`Atelier de menuiserie lumineux. ${IMAGE_RULES}`);
    const [submit] = calls;
    expect(submit).toMatchObject({ url: `${HIGGSFIELD_BASE_URL}/higgsfield-ai/soul/standard`, method: 'POST' });
    expect(submit?.headers).toMatchObject({ Authorization: 'Key id:secret', 'Content-Type': 'application/json', 'Idempotency-Key': expect.any(String) });
    expect(submit?.body).toEqual({ prompt: image.prompt, aspect_ratio: '16:9', resolution: '1080p', batch_size: 1, enhance_prompt: false });
    expect(calls.filter((c) => c.url.endsWith('/status'))).toHaveLength(3);
    expect(calls.at(-1)?.url).toBe('https://cdn.example.com/image-1.png');
  });

  it('choisit la proportion acceptée la plus proche de la zone photo', () => {
    expect(nearestAspect(1080, 1080)).toBe('1:1');
    expect(nearestAspect(1080, 1350)).toBe('3:4');
    expect(nearestAspect(1080, 640)).toBe('16:9');
    expect(nearestAspect(1080, 720)).toBe('3:2');
  });

  it('convertit en JPEG une image dans un format refusé par LinkedIn (WebP)', async () => {
    const { generator } = fakeApi([completed], { file: await encoded('webp') });
    const image = await generator.generate({ subject: 'Bureau', width: 1080, height: 1080 });
    expect(image.mime).toBe('image/jpeg');
    expect([...image.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('refus de modération, échec, clé refusée, crédits épuisés : erreurs explicites', async () => {
    await expect(fakeApi([{ status: 'nsfw' }]).generator.generate({ subject: 'x', width: 10, height: 10 })).rejects.toMatchObject({ message: expect.stringMatching(/modération/), retryable: false });
    await expect(fakeApi([{ status: 'failed', error: 'surcharge' }]).generator.generate({ subject: 'x', width: 10, height: 10 })).rejects.toMatchObject({ message: 'génération échouée : surcharge', retryable: true });
    await expect(fakeApi([], { submitStatus: 401 }).generator.generate({ subject: 'x', width: 10, height: 10 })).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/clé/) });
    await expect(fakeApi([], { submitStatus: 402 }).generator.generate({ subject: 'x', width: 10, height: 10 })).rejects.toMatchObject({ message: expect.stringMatching(/crédits/) });
    await expect(fakeApi([], { submitStatus: 503 }).generator.generate({ subject: 'x', width: 10, height: 10 })).rejects.toMatchObject({ retryable: true });
    await expect(fakeApi([], { submitStatus: 503 }).generator.generate({ subject: 'x', width: 10, height: 10 })).rejects.toBeInstanceOf(ImageGenerationError);
  });

  it('abandonne une génération trop longue', async () => {
    const calls: string[] = [];
    let now = 0;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      if (init?.method === 'POST') return Response.json({ request_id: 'r', status_url: `${HIGGSFIELD_BASE_URL}/requests/r/status` });
      return Response.json({ status: 'in_progress' });
    }) as typeof fetch;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const generator = new HiggsfieldImageGenerator({ keyId: 'a', keySecret: 'b', fetch: fetcher, timeoutMs: 10_000, sleep: async (ms) => void (now += ms), pollIntervalMs: 3_000 });
      await expect(generator.generate({ subject: 'x', width: 10, height: 10 })).rejects.toMatchObject({ message: expect.stringMatching(/trop longue/) });
      expect(calls.length).toBeGreaterThan(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('ne suit jamais une adresse de suivi hors de l’API', async () => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      if (init?.method === 'POST') return Response.json({ request_id: 'r-9', status_url: 'http://169.254.169.254/latest/meta-data' });
      if (String(input).endsWith('/status')) return Response.json(completed);
      return new Response(Buffer.from(await encoded('png')));
    }) as typeof fetch;
    await new HiggsfieldImageGenerator({ keyId: 'a', keySecret: 'b', fetch: fetcher, sleep: async () => undefined }).generate({ subject: 'x', width: 10, height: 10 });
    expect(calls[1]).toBe(`${HIGGSFIELD_BASE_URL}/requests/r-9/status`);
  });

  it('choix du générateur par l’environnement', () => {
    expect(imageGeneratorFromEnv({})).toBeNull();
    expect(imageGeneratorFromEnv({ IMAGE_MODE: 'fake' })).toBeInstanceOf(FakeImageGenerator);
    expect(imageGeneratorFromEnv({ IMAGE_MODE: 'higgsfield' })).toBeNull();
    const real = imageGeneratorFromEnv({ IMAGE_MODE: 'higgsfield', HIGGSFIELD_API_KEY_ID: 'a', HIGGSFIELD_API_KEY_SECRET: 'b', HIGGSFIELD_MODEL: 'qwen/image-3' });
    expect(real).toBeInstanceOf(HiggsfieldImageGenerator);
    expect((real as HiggsfieldImageGenerator).model).toBe('qwen/image-3');
  });
});

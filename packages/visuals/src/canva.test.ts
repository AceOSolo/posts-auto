import { describe, expect, it } from 'vitest';
import { CanvaConnectClient, CanvaError, guessCanvaFieldMap } from './canva.ts';
import { FakeCanvaApi } from './canva-fake.ts';

const NOW = new Date('2026-11-20T10:00:00Z');
type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(routes: Record<string, Route | Route[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = [...queues.keys()].find((k) => url.includes(k));
    if (key === undefined) return json({ message: 'introuvable' }, 404);
    const route = queues.get(key);
    const handler = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
    return (handler as Route)(url, init);
  }) as unknown as typeof fetch;
  return { api: new CanvaConnectClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, pollMs: 1 }), calls };
}

describe('client Canva Connect (VIS-07)', () => {
  it('adresse d’autorisation avec PKCE et les autorisations demandées', () => {
    const url = new URL(client({}).api.authorizeUrl({ state: 's', codeChallenge: 'c', redirectUri: 'https://app/retour' }));
    expect(url.origin).toBe('https://www.canva.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('scope')).toContain('brandtemplate:content:read');
  });

  it('échange du code, renouvellement, refus et panne réseau', async () => {
    const { api, calls } = client({ '/oauth/token': [() => json({ access_token: 'a', refresh_token: 'r', expires_in: 60 }), () => json({ access_token: 'b' }), () => json({ error: 'x' }, 400), () => json({}, 503)] });
    expect(await api.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }, NOW)).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(NOW.getTime() + 60_000) });
    expect(String(calls[0]?.init.headers && (calls[0].init.headers as Record<string, string>)['authorization'])).toMatch(/^Basic /);
    const refreshed = await api.refresh('r', NOW);
    expect(refreshed).toMatchObject({ accessToken: 'b', refreshToken: '' });
    expect(refreshed.expiresAt.getTime()).toBe(NOW.getTime() + 14_400_000);
    await expect(api.refresh('r', NOW)).rejects.toMatchObject({ retryable: false });
    await expect(api.refresh('r', NOW)).rejects.toMatchObject({ retryable: true });
    const offline = new CanvaConnectClient({ clientId: 'i', clientSecret: 's', fetch: (async () => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch });
    await expect(offline.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }, NOW)).rejects.toBeInstanceOf(CanvaError);
    await expect(offline.brandTemplates('t')).rejects.toMatchObject({ retryable: true });
  });

  it('modèles de marque et champs', async () => {
    const { api } = client({
      '/brand-templates?': () => json({ items: [{ id: 'B1', title: 'Annonce' }, { id: 'B2' }] }),
      '/dataset': () => json({ dataset: { titre: { type: 'text' }, photo: { type: 'image' }, graphique: { type: 'chart' } } }),
    });
    expect(await api.brandTemplates('t')).toEqual([
      { id: 'B1', title: 'Annonce' },
      { id: 'B2', title: 'Modèle Canva' },
    ]);
    expect(await api.dataset('t', 'B1')).toEqual({ titre: 'text', photo: 'image' });
  });

  it('envoi d’image, remplissage et export : tâches suivies jusqu’au bout', async () => {
    const { api, calls } = client({
      '/asset-uploads/': [() => json({ job: { status: 'in_progress' } }), () => json({ job: { status: 'success', asset: { id: 'A1' } } })],
      '/asset-uploads': () => json({ job: { id: 'J1', status: 'in_progress' } }),
      '/autofills/': () => json({ job: { status: 'success', result: { design: { id: 'D1' } } } }),
      '/autofills': () => json({ job: { id: 'J2' } }),
      '/exports/': () => json({ job: { status: 'success', urls: ['https://export.canva.test/f.png'] } }),
      '/exports': () => json({ job: { id: 'J3' } }),
      'export.canva.test': () => new Response(new Uint8Array([1, 2, 3])),
    });
    expect(await api.uploadImage('t', 'photo.png', new Uint8Array([9]))).toBe('A1');
    const upload = calls.find((c) => c.url.endsWith('/asset-uploads'));
    expect(JSON.parse(String((upload?.init.headers as Record<string, string>)['asset-upload-metadata']))).toEqual({ name_base64: Buffer.from('photo.png').toString('base64') });
    const result = await api.renderPng('t', 'B1', 'Titre', { titre: { type: 'text', text: 'Bonjour' }, photo: { type: 'image', assetId: 'A1' } });
    expect(result).toEqual({ png: new Uint8Array([1, 2, 3]), designId: 'D1' });
    const autofill = calls.find((c) => c.url.endsWith('/autofills'));
    expect(JSON.parse(String(autofill?.init.body))).toEqual({ brand_template_id: 'B1', title: 'Titre', data: { titre: { type: 'text', text: 'Bonjour' }, photo: { type: 'image', asset_id: 'A1' } } });
  });

  it('tâche en échec, export sans fichier, fichier illisible, refus de l’API', async () => {
    const failed = client({ '/autofills/': () => json({ job: { status: 'failed', error: { message: 'champ inconnu' } } }), '/autofills': () => json({ job: { id: 'J' } }) });
    await expect(failed.api.renderPng('t', 'B', 'T', {})).rejects.toThrow(/champ inconnu/);
    const noUrl = client({
      '/autofills/': () => json({ job: { status: 'success', result: { design: { id: 'D' } } } }),
      '/autofills': () => json({ job: { id: 'J' } }),
      '/exports/': () => json({ job: { status: 'success', urls: [] } }),
      '/exports': () => json({ job: { id: 'E' } }),
    });
    await expect(noUrl.api.renderPng('t', 'B', 'T', {})).rejects.toThrow(/sans fichier/);
    const badFile = client({
      '/autofills/': () => json({ job: { status: 'success', result: { design: { id: 'D' } } } }),
      '/autofills': () => json({ job: { id: 'J' } }),
      '/exports/': () => json({ job: { status: 'success', urls: ['https://export.canva.test/x'] } }),
      '/exports': () => json({ job: { id: 'E' } }),
      'export.canva.test': () => new Response('', { status: 403 }),
    });
    await expect(badFile.api.renderPng('t', 'B', 'T', {})).rejects.toThrow(/illisible/);
    const limited = client({ '/brand-templates?': () => json({ message: 'trop de requêtes' }, 429) });
    await expect(limited.api.brandTemplates('t')).rejects.toMatchObject({ retryable: true, message: 'Canva : trop de requêtes' });
    const forbidden = client({ '/brand-templates?': () => new Response('pas du json', { status: 403 }) });
    await expect(forbidden.api.brandTemplates('t')).rejects.toMatchObject({ retryable: false, message: 'Canva : HTTP 403' });
  });

  it('rapprochement des champs : titre par défaut, image par défaut, pas de doublon', () => {
    expect(guessCanvaFieldMap({ texte: 'text', visuel: 'image' })).toEqual({ title: 'texte', photo: 'visuel' });
    expect(guessCanvaFieldMap({ Titre: 'text', Nom: 'text', Image: 'image' })).toEqual({ title: 'Titre', signature: 'Nom', photo: 'Image' });
    expect(guessCanvaFieldMap({})).toEqual({});
  });
});

describe('Canva simulé', () => {
  it('connexion, modèles, envoi et rendu local', async () => {
    const api = new FakeCanvaApi('http://localhost');
    expect(api.authorizeUrl({ state: 's', redirectUri: 'http://localhost/retour' })).toContain('code=fake-canva');
    await expect(api.exchangeCode({ code: 'autre' }, NOW)).rejects.toThrow();
    expect((await api.exchangeCode({ code: 'fake-canva' }, NOW)).accessToken).toBe('canva-access');
    expect((await api.refresh('r', NOW)).refreshToken).toBe('canva-refresh');
    expect(await api.brandTemplates()).toHaveLength(2);
    expect(await api.dataset()).toMatchObject({ photo: 'image' });
    const asset = await api.uploadImage('t', 'p.png', new Uint8Array([1]));
    const text = await api.renderPng('t', 'BT', 'Titre', { titre: { type: 'text', text: 'Bonjour' }, points: { type: 'text', text: 'a\nb' } });
    expect(text.png.length).toBeGreaterThan(1000);
    expect(api.designs[0]).toMatchObject({ brandTemplateId: 'BT' });
    expect(asset).toBe('asset-fake-1');
  });
});

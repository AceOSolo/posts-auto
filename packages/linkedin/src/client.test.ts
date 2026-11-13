/**
 * Client HTTP LinkedIn, testé contre un faux serveur (fetch remplacé) : forme exacte des
 * requêtes, et classification des pannes selon que le post a pu être créé ou non.
 */
import { describe, expect, it } from 'vitest';
import { type PublishRequest, LinkedInHttpClient } from './client.js';
import { LinkedInError, describeForUser } from './errors.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = ((call: Recorded) => Response | Promise<Response>) | Response;

function fakeServer(...handlers: Handler[]) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = init?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const call = { url: String(input), method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const handler = handlers[calls.length - 1];
    if (handler === undefined) throw new Error(`Appel inattendu : ${call.method} ${call.url}`);
    return typeof handler === 'function' ? handler(call) : handler;
  }) as typeof fetch;
  return { calls, client: new LinkedInHttpClient({ apiVersion: '202610', fetch: fetchImpl }) };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const created = (urn: string) => new Response(null, { status: 201, headers: { 'x-restli-id': urn } });
const initUpload = (n: number) =>
  json(200, { value: { uploadUrl: `https://upload.example/${n}`, image: `urn:li:image:IMG${n}` } });
const uploaded = () => new Response(null, { status: 201 });
const networkError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

const png = (n: number) => ({ bytes: new Uint8Array([n]), mime: 'image/png' as const, altText: `Photo ${n}` });
const request = (images = 0): PublishRequest => ({
  authorUrn: 'urn:li:person:abc123',
  text: 'Trois réflexes (à garder) :\n* aérer',
  images: Array.from({ length: images }, (_, i) => png(i + 1)),
});

async function failureOf(promise: Promise<unknown>): Promise<LinkedInError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof LinkedInError)) throw new Error(`LinkedInError attendue, reçu : ${String(error)}`);
  return error;
}

describe('publication d’un post', () => {
  it('texte seul : en-têtes versionnés, texte échappé, URL du post', async () => {
    const { calls, client } = fakeServer(() => created('urn:li:share:1'));
    const result = await client.publish('TOKEN', request());
    expect(result).toEqual({ postUrn: 'urn:li:share:1', url: 'https://www.linkedin.com/feed/update/urn:li:share:1/' });
    expect(calls[0]).toMatchObject({
      url: 'https://api.linkedin.com/rest/posts',
      method: 'POST',
      headers: { authorization: 'Bearer TOKEN', 'linkedin-version': '202610', 'x-restli-protocol-version': '2.0.0' },
      body: {
        author: 'urn:li:person:abc123',
        commentary: 'Trois réflexes \\(à garder\\) :\n\\* aérer',
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
        distribution: { feedDistribution: 'MAIN_FEED' },
      },
    });
    expect(calls[0]?.body).not.toHaveProperty('content');
  });

  it('une image : envoi préalable de l’image, puis post « media »', async () => {
    const { calls, client } = fakeServer(initUpload(1), uploaded, () => created('urn:li:share:2'));
    await client.publish('TOKEN', request(1));
    expect(calls[0]).toMatchObject({
      url: 'https://api.linkedin.com/rest/images?action=initializeUpload',
      body: { initializeUploadRequest: { owner: 'urn:li:person:abc123' } },
    });
    expect(calls[1]).toMatchObject({ url: 'https://upload.example/1', method: 'PUT', headers: { 'content-type': 'image/png' } });
    expect(calls[2]?.body).toMatchObject({ content: { media: { id: 'urn:li:image:IMG1', altText: 'Photo 1' } } });
  });

  it('trois images : post « multiImage » dans l’ordre choisi (REC-05)', async () => {
    const { calls, client } = fakeServer(initUpload(1), uploaded, initUpload(2), uploaded, initUpload(3), uploaded, () =>
      created('urn:li:ugcPost:3'),
    );
    await client.publish('TOKEN', request(3));
    expect(calls[6]?.body).toMatchObject({
      content: { multiImage: { images: [{ id: 'urn:li:image:IMG1' }, { id: 'urn:li:image:IMG2' }, { id: 'urn:li:image:IMG3' }] } },
    });
  });

  it('refuse avant tout appel un texte vide, trop long, ou un auteur invalide', async () => {
    const { calls, client } = fakeServer();
    for (const bad of [
      { ...request(), text: '   ' },
      { ...request(), text: 'x'.repeat(3001) },
      { ...request(), authorUrn: 'jp' },
    ]) {
      expect((await failureOf(client.publish('TOKEN', bad))).kind).toBe('invalid');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('pannes : le post a-t-il pu être créé ?', () => {
  it('connexion refusée à la création : pas créé, nouvel essai possible (REC-08)', async () => {
    const { client } = fakeServer(() => {
      throw networkError('ECONNREFUSED');
    });
    const error = await failureOf(client.publish('TOKEN', request()));
    expect(error).toMatchObject({ kind: 'network', outcome: 'not_created', phase: 'post_create' });
    expect(error.retryable).toBe(true);
  });

  it('coupure après l’envoi de la création : issue incertaine, aucun nouvel essai automatique', async () => {
    const { client } = fakeServer(() => {
      throw networkError('ECONNRESET');
    });
    const error = await failureOf(client.publish('TOKEN', request()));
    expect(error).toMatchObject({ outcome: 'unknown', retryable: false });
    expect(describeForUser(error)).toMatch(/Vérifiez sur LinkedIn avant de réessayer/);
  });

  it('délai dépassé à la création : issue incertaine', async () => {
    const { client } = fakeServer(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    expect(await failureOf(client.publish('TOKEN', request()))).toMatchObject({ outcome: 'unknown' });
  });

  it('toute panne pendant l’envoi des images est sans risque : le post n’existe pas encore', async () => {
    const { client } = fakeServer(initUpload(1), () => {
      throw networkError('ECONNRESET');
    });
    const error = await failureOf(client.publish('TOKEN', request(1)));
    expect(error).toMatchObject({ phase: 'image_upload', outcome: 'not_created', retryable: true });
  });

  it.each([
    [503, 'server', 'not_created', true],
    [429, 'rate_limit', 'not_created', true],
    [409, 'conflict', 'not_created', true],
    [500, 'server', 'unknown', false],
    [502, 'server', 'unknown', false],
    [504, 'server', 'unknown', false],
    [401, 'auth', 'not_created', false],
    [403, 'permission', 'not_created', false],
    [422, 'invalid', 'not_created', false],
  ] as const)('HTTP %i à la création → %s, %s, nouvel essai : %s', async (status, kind, outcome, retryable) => {
    const { client } = fakeServer(() => json(status, { message: 'X', code: 'CODE' }));
    expect(await failureOf(client.publish('TOKEN', request()))).toMatchObject({ kind, outcome, retryable, status, code: 'CODE' });
  });

  it('réponse 201 sans identifiant : issue incertaine', async () => {
    const { client } = fakeServer(() => new Response(null, { status: 201 }));
    expect(await failureOf(client.publish('TOKEN', request()))).toMatchObject({ outcome: 'unknown' });
  });

  it('traduit chaque cas pour le titulaire', () => {
    const make = (kind: LinkedInError['kind']) =>
      new LinkedInError({ kind, phase: 'post_create', outcome: 'not_created', message: 'x' });
    expect(describeForUser(make('auth'))).toMatch(/reconnectez le compte/);
    expect(describeForUser(make('permission'))).toMatch(/droits/);
    expect(describeForUser(make('invalid'))).toMatch(/refusé le contenu/);
    expect(describeForUser(make('rate_limit'))).toMatch(/limite/);
    expect(describeForUser(make('server'))).toMatch(/indisponible/);
    expect(describeForUser(make('network'))).toMatch(/injoignable/);
  });
});

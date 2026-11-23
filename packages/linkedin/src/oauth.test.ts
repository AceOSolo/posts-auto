import { describe, expect, it } from 'vitest';
import { LinkedInError } from './errors.ts';
import { FakeLinkedInOAuth, LinkedInOAuthClient, PROFILE_SCOPES } from './oauth.ts';

const NOW = new Date('2026-11-16T09:00:00Z');
const config = { clientId: 'app-a', clientSecret: 'secret', redirectUri: 'https://app.example/comptes/connecter/retour' };

function client(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    return handler(String(input), init);
  }) as typeof fetch;
  return { calls, oauth: new LinkedInOAuthClient({ ...config, fetch: fetchImpl }) };
}

describe('OAuth LinkedIn (LNK-01)', () => {
  it('construit l’adresse d’autorisation avec les permissions minimales et l’état anti-CSRF', () => {
    const { oauth } = client(() => new Response());
    const url = new URL(oauth.authorizationUrl('etat-123', PROFILE_SCOPES));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'app-a',
      redirect_uri: config.redirectUri,
      state: 'etat-123',
      scope: 'openid profile w_member_social',
    });
  });

  it('échange le code contre des jetons et calcule les échéances', async () => {
    const { calls, oauth } = client(() =>
      Response.json({ access_token: 'AT', expires_in: 5_184_000, refresh_token: 'RT', refresh_token_expires_in: 31_536_000, scope: 'openid,profile,w_member_social' }),
    );
    const tokens = await oauth.exchangeCode('CODE', NOW);
    expect(tokens).toEqual({
      accessToken: 'AT',
      expiresAt: new Date('2027-01-15T09:00:00Z'), // 60 jours
      refreshToken: 'RT',
      refreshExpiresAt: new Date('2027-11-16T09:00:00Z'), // 365 jours
      scopes: ['openid', 'profile', 'w_member_social'],
    });
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', code: 'CODE', client_id: 'app-a', redirect_uri: config.redirectUri });
  });

  it('accepte une réponse sans jeton de renouvellement (application non partenaire)', async () => {
    const { oauth } = client(() => Response.json({ access_token: 'AT', expires_in: 5_184_000, scope: 'openid profile' }));
    expect(await oauth.exchangeCode('CODE', NOW)).toMatchObject({ refreshToken: null, refreshExpiresAt: null });
  });

  it('traduit un refus de LinkedIn en erreur d’authentification', async () => {
    const { oauth } = client(() => Response.json({ error: 'invalid_request', error_description: 'Code expiré' }, { status: 400 }));
    const error = await oauth.exchangeCode('VIEUX', NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkedInError);
    expect(error).toMatchObject({ kind: 'auth', message: 'LinkedIn a refusé la connexion : Code expiré' });
  });

  it('renouvelle un jeton d’accès avec le jeton de renouvellement', async () => {
    const { calls, oauth } = client(() => Response.json({ access_token: 'AT2', expires_in: 5_184_000 }));
    expect((await oauth.refresh('RT', NOW)).accessToken).toBe('AT2');
    expect(new URLSearchParams(String(calls[0]?.init?.body)).get('grant_type')).toBe('refresh_token');
  });

  it('lit l’identité du membre et en déduit son URN', async () => {
    const { calls, oauth } = client(() => Response.json({ sub: '782bbtaQ', name: 'John Doe', picture: 'https://media.example/p.jpg' }));
    expect(await oauth.memberProfile('AT')).toEqual({ sub: '782bbtaQ', urn: 'urn:li:person:782bbtaQ', name: 'John Doe', pictureUrl: 'https://media.example/p.jpg' });
    expect(calls[0]?.url).toBe('https://api.linkedin.com/v2/userinfo');
  });

  it('refuse un profil sans identifiant ou un jeton rejeté', async () => {
    await expect(client(() => Response.json({ name: 'X' })).oauth.memberProfile('AT')).rejects.toMatchObject({ kind: 'auth' });
    await expect(client(() => new Response(null, { status: 401 })).oauth.memberProfile('AT')).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });
});

describe('OAuth simulé (développement)', () => {
  it('passe par l’écran simulé et fournit un jeton, une identité et une photo', async () => {
    const fake = new FakeLinkedInOAuth('http://localhost:3000/comptes/connecter/retour');
    const url = new URL(fake.authorizationUrl('etat-abcdefghijklmnop'));
    expect(url.pathname).toBe('/comptes/connecter/simulation');
    expect(url.searchParams.get('state')).toBe('etat-abcdefghijklmnop');
    const tokens = await fake.exchangeCode(url.searchParams.get('code') as string, NOW);
    const profile = await fake.memberProfile(tokens.accessToken);
    expect(profile.urn).toMatch(/^urn:li:person:demo/);
    expect(profile.pictureUrl).toMatch(/^data:image\/svg\+xml,/);
    await expect(fake.exchangeCode('autre', NOW)).rejects.toMatchObject({ kind: 'auth' });
  });
});

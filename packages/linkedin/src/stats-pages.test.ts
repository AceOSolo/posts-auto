import { describe, expect, it } from 'vitest';
import { FakeLinkedInPages, LinkedInPagesClient } from './pages.ts';
import { FakeLinkedInStats, LinkedInStatsClient } from './stats.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fetcher(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const impl = (async (input: string | URL) => {
    urls.push(String(input));
    return handler(String(input));
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('statistiques LinkedIn (SUI-03)', () => {
  it('post d’une page : statistiques de l’organisation (share ou ugcPost)', async () => {
    const f = fetcher(() => json({ elements: [{ totalShareStatistics: { impressionCount: 1200, likeCount: 30, commentCount: 4, shareCount: -1 } }] }));
    const stats = new LinkedInStatsClient({ apiVersion: '202610', fetch: f.impl });
    expect(await stats.postStats({ accessToken: 't', postUrn: 'urn:li:share:1', authorUrn: 'urn:li:organization:9' })).toEqual({ impressions: 1200, reactions: 30, comments: 4, shares: null });
    expect(f.urls[0]).toContain('shares=List(urn%3Ali%3Ashare%3A1)');
    await stats.postStats({ accessToken: 't', postUrn: 'urn:li:ugcPost:2', authorUrn: 'urn:li:organization:9' });
    expect(f.urls[1]).toContain('ugcPosts=List(');
    const empty = new LinkedInStatsClient({ apiVersion: '202610', fetch: fetcher(() => json({ elements: [] })).impl });
    expect(await empty.postStats({ accessToken: 't', postUrn: 'urn:li:share:1', authorUrn: 'urn:li:organization:9' })).toBeNull();
  });

  it('post d’un profil : une mesure par appel ; permission absente → indisponible', async () => {
    const counts: Record<string, number> = { IMPRESSION: 900, REACTION: 12, COMMENT: 3, RESHARE: 1 };
    const f = fetcher((url) => json({ elements: [{ count: counts[/queryType=(\w+)/.exec(url)?.[1] ?? ''] }] }));
    const stats = new LinkedInStatsClient({ apiVersion: '202610', fetch: f.impl });
    expect(await stats.postStats({ accessToken: 't', postUrn: 'urn:li:share:5', authorUrn: 'urn:li:person:x' })).toEqual({ impressions: 900, reactions: 12, comments: 3, shares: 1 });
    expect(f.urls[0]).toContain('entity=(share:');
    await stats.postStats({ accessToken: 't', postUrn: 'urn:li:ugcPost:5', authorUrn: 'urn:li:person:x' });
    expect(f.urls[4]).toContain('entity=(ugc:');
    const forbidden = new LinkedInStatsClient({ apiVersion: '202610', fetch: fetcher(() => json({}, 403)).impl });
    expect(await forbidden.postStats({ accessToken: 't', postUrn: 'urn:li:share:5', authorUrn: 'urn:li:person:x' })).toBeNull();
  });

  it('abonnés d’une page ; panne de LinkedIn ou du réseau : erreur à réessayer', async () => {
    const stats = new LinkedInStatsClient({ apiVersion: '202610', fetch: fetcher(() => json({ firstDegreeSize: 4321 })).impl });
    expect(await stats.followers({ accessToken: 't', organizationUrn: 'urn:li:organization:9' })).toBe(4321);
    const unknown = new LinkedInStatsClient({ apiVersion: '202610', fetch: fetcher(() => json({}, 404)).impl });
    expect(await unknown.followers({ accessToken: 't', organizationUrn: 'urn:li:organization:9' })).toBeNull();
    const down = new LinkedInStatsClient({ apiVersion: '202610', fetch: fetcher(() => json({}, 503)).impl });
    await expect(down.followers({ accessToken: 't', organizationUrn: 'urn:li:organization:9' })).rejects.toMatchObject({ kind: 'server' });
    const offline = new LinkedInStatsClient({ apiVersion: '202610', fetch: (async () => Promise.reject(new Error('ETIMEDOUT'))) as unknown as typeof fetch });
    await expect(offline.followers({ accessToken: 't', organizationUrn: 'urn:li:organization:9' })).rejects.toMatchObject({ kind: 'network' });
  });

  it('statistiques simulées : stables pour un même post', async () => {
    const fake = new FakeLinkedInStats();
    expect(await fake.postStats({ postUrn: 'urn:li:share:1' })).toEqual(await fake.postStats({ postUrn: 'urn:li:share:1' }));
    expect(await fake.followers({ organizationUrn: 'urn:li:organization:1' })).toBeGreaterThanOrEqual(500);
  });
});

describe('pages d’entreprise (LNK-02, PUB-08)', () => {
  it('pages administrées : rôles puis noms, sans doublon', async () => {
    const f = fetcher((url) =>
      url.includes('organizationAcls')
        ? json({ elements: [{ organization: 'urn:li:organization:1' }, { organization: 'urn:li:organization:1' }, { organization: 'pas-une-urn' }, { organization: 'urn:li:organization:2' }] })
        : url.endsWith('/1')
          ? json({ localizedName: 'Secutop', vanityName: 'secutop' })
          : json({}),
    );
    const pages = new LinkedInPagesClient({ apiVersion: '202610', fetch: f.impl });
    expect(await pages.administeredPages('t')).toEqual([
      { urn: 'urn:li:organization:1', name: 'Secutop', vanityName: 'secutop' },
      { urn: 'urn:li:organization:2', name: 'Page 2', vanityName: null },
    ]);
  });

  it('accès refusé ou erreur : message clair', async () => {
    const refused = new LinkedInPagesClient({ apiVersion: '202610', fetch: fetcher(() => json({}, 403)).impl });
    await expect(refused.administeredPages('t')).rejects.toThrow(/Community Management API/);
    const broken = new LinkedInPagesClient({ apiVersion: '202610', fetch: fetcher(() => json({}, 500)).impl });
    await expect(broken.administeredPages('t')).rejects.toThrow(/HTTP 500/);
  });

  it('recherche d’une page par son nom d’adresse (PUB-08)', async () => {
    const found = new LinkedInPagesClient({ apiVersion: '202610', fetch: fetcher(() => json({ elements: [{ id: 77, localizedName: 'Secutop' }] })).impl });
    expect(await found.lookupOrganization('t', 'secutop')).toEqual({ urn: 'urn:li:organization:77', name: 'Secutop' });
    const unnamed = new LinkedInPagesClient({ apiVersion: '202610', fetch: fetcher(() => json({ elements: [{ id: 78 }] })).impl });
    expect(await unnamed.lookupOrganization('t', 'acme')).toEqual({ urn: 'urn:li:organization:78', name: 'acme' });
    const none = new LinkedInPagesClient({ apiVersion: '202610', fetch: fetcher(() => json({ elements: [] })).impl });
    expect(await none.lookupOrganization('t', 'rien')).toBeNull();
    const refused = new LinkedInPagesClient({ apiVersion: '202610', fetch: fetcher(() => json({}, 403)).impl });
    expect(await refused.lookupOrganization('t', 'x')).toBeNull();
    const fake = new FakeLinkedInPages();
    expect(await fake.lookupOrganization('t', 'inconnue')).toBeNull();
    expect((await fake.lookupOrganization('t', 'ma-page'))?.name).toBe('Ma page');
  });
});

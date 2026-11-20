import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { contrastRatio } from '@posts-auto/visuals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFetchError } from '../net/safe-fetch.ts';
import { logoCandidates, pickFont, pickPalette, proposeBrandFromWebsite, weightedColors } from './brand-extraction.ts';

// PNG 1 × 1 valide.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const HTML = `<!doctype html><html><head>
<meta name="theme-color" content="#1f6feb">
<link rel="stylesheet" href="/style.css">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700" rel="stylesheet">
<link rel="apple-touch-icon" href="/apple.png">
</head><body><header><img class="site-logo" src="/img/logo.png" alt="Logo Atelier"></header>
<p style="color:#333333">Texte</p></body></html>`;
const CSS = `:root{--brand-accent:#ff7a00;--bg:#fafafa}body{background:#fafafa;color:#222}a{color:#1f6feb}.btn{background:#ff7a00}`;

describe('extraction de la charte (ONB-05)', () => {
  it('couleurs : theme-color et variables de marque d’abord ; texte blanc lisible sur la principale', () => {
    const palette = pickPalette(weightedColors(HTML, [CSS]));
    expect(contrastRatio('#ffffff', palette.primary)).toBeGreaterThanOrEqual(4.5);
    expect(palette.secondary).toBe('#ff7a00');
    expect(palette.light).toBe('#fafafa');
    expect(palette.dark).toBe('#222222');
    expect(pickPalette(new Map())).toEqual({ primary: '#0f3d5e', secondary: '#f0a500', light: '#f5f7fa', dark: '#1a1a1a' });
  });

  it('police rapprochée des trois disponibles', () => {
    expect(pickFont(HTML, [])).toBe('lora');
    expect(pickFont('', ['h1{font-family:"Poppins",sans-serif}'])).toBe('montserrat');
    expect(pickFont('', ['body{font-family:Arial,Helvetica,sans-serif}'])).toBe('inter');
  });

  it('logo : image marquée « logo », puis icône Apple ; adresses absolues, pas de SVG', () => {
    expect(logoCandidates(HTML, 'https://atelier.fr/')).toEqual(['https://atelier.fr/img/logo.png', 'https://atelier.fr/apple.png']);
    expect(logoCandidates('<img src="logo.svg" class="logo">', 'https://a.fr/')).toEqual([]);
  });
});

describe('proposition depuis le site', () => {
  let db: Database;
  let workspaceId: string;
  let admin: string;
  const written = new Map<string, Uint8Array>();
  const media = { write: async (key: string, bytes: Uint8Array) => void written.set(key, bytes) };
  beforeAll(async () => {
    db = await openTestDatabase();
    const org = await createOrganization(db);
    workspaceId = org.workspaceIds[0] as string;
    admin = await createUser(db, 'charte');
    await addMember(db, workspaceId, admin, 'admin');
  });
  afterAll(() => closeTestDatabase(db));

  it('propose couleurs, police et logo (gardé dans la médiathèque), sans rien enregistrer dans la charte', async () => {
    const fetchText = async (url: string) => ({ text: url.endsWith('.css') ? CSS : HTML, url: url.endsWith('.css') ? url : 'https://atelier.fr/' });
    const fetchBytes = async (url: string) => {
      if (url.includes('logo')) throw new SafeFetchError('statut', '404');
      return { bytes: new Uint8Array(PNG), url, contentType: 'image/png' };
    };
    const proposal = await proposeBrandFromWebsite(db, media, admin, workspaceId, 'atelier.fr', new Date(), { fetchText, fetchBytes });
    expect(proposal).toMatchObject({ secondary: '#ff7a00', font: 'lora', sourceUrl: 'https://atelier.fr/' });
    expect(proposal.logoAssetId).not.toBeNull();
    const asset = await asSystem(db, (trx) => trx.selectFrom('media_assets').select(['label', 'mime']).where('id', '=', proposal.logoAssetId as string).executeTakeFirstOrThrow());
    expect(asset).toEqual({ label: 'Logo du site', mime: 'image/png' });
    const ws = await asSystem(db, (trx) => trx.selectFrom('workspaces').select('branding').where('id', '=', workspaceId).executeTakeFirstOrThrow());
    expect(ws.branding).toBeNull();
  });

  it('site illisible : refus clair', async () => {
    const fetchText = async () => {
      throw new SafeFetchError('interdite', 'Adresse interdite.');
    };
    await expect(proposeBrandFromWebsite(db, media, admin, workspaceId, 'http://127.0.0.1', new Date(), { fetchText })).rejects.toMatchObject({ code: 'site_illisible' });
  });
});

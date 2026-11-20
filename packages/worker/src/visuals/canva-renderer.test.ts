import { randomBytes } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createOrganization, openTestDatabase } from '@posts-auto/db/testing';
import { FakeCanvaApi, FakeImageGenerator } from '@posts-auto/visuals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenCipher } from '../secrets/token-cipher.ts';
import { canvaRenderer } from './canva-renderer.ts';

let db: Database;
let workspaceId: string;
const cipher = new TokenCipher(new Map([['k1', randomBytes(32)]]), 'k1');
const NOW = new Date('2026-11-20T10:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
});
afterAll(() => closeTestDatabase(db));

describe('rendu par Canva (VIS-07)', () => {
  it('sans connexion : erreur ; avec : champs remplis, photo envoyée, jeton renouvelé', async () => {
    const api = new FakeCanvaApi('http://localhost');
    const photo = (await new FakeImageGenerator().generate({ subject: 'chantier', width: 400, height: 300 })).bytes;
    const render = canvaRenderer(db, api, cipher, () => NOW);
    const input = {
      workspaceId,
      brandTemplateId: 'BT-fake-annonce',
      fields: { title: 'titre', subtitle: 'sous_titre', bullets: 'points', signature: 'signature', photo: 'photo' },
      title: 'Marie · Sécurité',
      content: { title: 'Sécurité', subtitle: 'Sur les chantiers', bullets: ['Casque', 'Harnais'], signature: 'Marie', photo },
    };
    await expect(render(input)).rejects.toThrow(/plus connecté/);

    await asSystem(db, (trx) =>
      trx
        .insertInto('canva_connections')
        .values({
          workspace_id: workspaceId,
          access_token_enc: Buffer.from(cipher.encrypt('ancien', `canva:${workspaceId}`)),
          refresh_token_enc: Buffer.from(cipher.encrypt('canva-refresh', `canva-refresh:${workspaceId}`)),
          // Échéance proche : le jeton est renouvelé avant l'appel.
          expires_at: new Date(NOW.getTime() + 60_000),
        })
        .execute(),
    );
    const png = await render(input);
    expect(png.length).toBeGreaterThan(1000);
    expect(api.uploads.size).toBe(1);
    expect(api.designs[0]?.data).toEqual({
      titre: { type: 'text', text: 'Sécurité' },
      sous_titre: { type: 'text', text: 'Sur les chantiers' },
      points: { type: 'text', text: 'Casque\nHarnais' },
      signature: { type: 'text', text: 'Marie' },
      photo: { type: 'image', assetId: 'asset-fake-1' },
    });
    const renewed = await asSystem(db, (trx) => trx.selectFrom('canva_connections').select('expires_at').where('workspace_id', '=', workspaceId).executeTakeFirstOrThrow());
    expect(renewed.expires_at.getTime()).toBeGreaterThan(NOW.getTime() + 3_600_000);

    // Sans photo ni sous-titre ni points : seuls les champs utiles sont remplis.
    await render({ ...input, fields: { title: 'titre' }, content: { ...input.content, subtitle: null, bullets: [], photo: null } });
    expect(api.designs[1]?.data).toEqual({ titre: { type: 'text', text: 'Sécurité' } });
  });
});

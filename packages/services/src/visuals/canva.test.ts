import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { FakeCanvaApi, guessCanvaFieldMap } from '@posts-auto/visuals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { addCanvaTemplate, canvaAccessToken, canvaStatus, confirmCanvaConnection, listCanvaBrandTemplates } from './canva.ts';

let db: Database;
let workspaceId: string;
let admin: string;
let contributor: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const cipher = {
  encrypt: (plaintext: string, boundTo: string) => Buffer.from(`${boundTo}|${plaintext}`),
  decrypt: (payload: Uint8Array, boundTo: string) => {
    const [bound, plaintext] = Buffer.from(payload).toString().split('|');
    if (bound !== boundTo) throw new Error('lié ailleurs');
    return plaintext as string;
  },
};
const api = new FakeCanvaApi('http://localhost:3001');

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  admin = await createUser(db, 'canva-admin');
  contributor = await createUser(db, 'canva-contrib');
  await addMember(db, workspaceId, admin, 'admin');
  await addMember(db, workspaceId, contributor, 'contributor');
});
afterAll(() => closeTestDatabase(db));

describe('connecteur Canva (VIS-07)', () => {
  it('champs du modèle reliés aux zones d’après leur nom', () => {
    expect(guessCanvaFieldMap({ 'Titre principal': 'text', 'Sous-titre': 'text', 'Liste de points': 'text', Photo: 'image', Logo: 'image' })).toEqual({
      title: 'Titre principal',
      subtitle: 'Sous-titre',
      bullets: 'Liste de points',
      photo: 'Photo',
    });
  });

  it('connexion par qui gère le contenu, jetons chiffrés et renouvelés ; modèle de marque ajouté', async () => {
    const input = { code: 'fake-canva', codeVerifier: 'v', redirectUri: 'http://localhost:3001/visuels/canva/retour' };
    await expect(confirmCanvaConnection(db, api, cipher, contributor, workspaceId, input, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await confirmCanvaConnection(db, api, cipher, admin, workspaceId, input, NOW);
    expect(await canvaStatus(db, admin, workspaceId)).toMatchObject({ connected: true });
    const stored = await asSystem(db, (trx) => trx.selectFrom('canva_connections').select('access_token_enc').where('workspace_id', '=', workspaceId).executeTakeFirstOrThrow());
    expect(Buffer.from(stored.access_token_enc).toString()).toBe(`canva:${workspaceId}|canva-access`);
    // Jeton à moins de 5 minutes de l'échéance : renouvelé.
    const later = new Date(NOW.getTime() + 4 * 3_600_000 - 60_000);
    expect(await asSystem(db, (trx) => canvaAccessToken(trx, api, cipher, workspaceId, later))).toBe('canva-access');
    const renewed = await asSystem(db, (trx) => trx.selectFrom('canva_connections').select('expires_at').where('workspace_id', '=', workspaceId).executeTakeFirstOrThrow());
    expect(renewed.expires_at.getTime()).toBeGreaterThan(later.getTime());

    const choices = await listCanvaBrandTemplates(db, api, cipher, admin, workspaceId, NOW);
    expect(choices.map((c) => c.added)).toEqual([false, false]);
    const templateId = await addCanvaTemplate(db, api, cipher, admin, workspaceId, 'BT-fake-annonce', NOW);
    const row = await asSystem(db, (trx) => trx.selectFrom('templates').select(['name', 'canva_brand_template_id', 'canva_fields']).where('id', '=', templateId).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ name: 'Annonce (Canva)', canva_brand_template_id: 'BT-fake-annonce', canva_fields: { title: 'titre', subtitle: 'sous_titre', bullets: 'points', photo: 'photo' } });
    expect((await listCanvaBrandTemplates(db, api, cipher, admin, workspaceId, NOW)).find((c) => c.id === 'BT-fake-annonce')?.added).toBe(true);
  });
});

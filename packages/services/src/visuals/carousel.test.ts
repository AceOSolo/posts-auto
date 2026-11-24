import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carouselPages, makeCarousel } from './carousel.ts';

let db: Database;
let workspaceId: string;
let editor: string;
let postId: string;
const files = new Map<string, Uint8Array>();
const media = { read: async (k: string) => files.get(k) as Uint8Array, write: async (k: string, b: Uint8Array) => void files.set(k, b) };
const NOW = new Date('2026-11-20T10:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  editor = await createUser(db, 'carrousel-editor');
  await addMember(db, workspaceId, editor, 'editor');
  const accountId = await createAccount(db, workspaceId);
  postId = await createPost(db, workspaceId, accountId, { status: 'a_valider', scheduled_at: new Date('2026-12-01T10:00:00Z') });
  await asSystem(db, async (trx) => {
    const asset = await trx
      .insertInto('media_assets')
      .values({
        workspace_id: workspaceId,
        kind: 'rendered',
        storage_key: `${workspaceId}/visuels/v.png`,
        mime: 'image/png',
        render_content: JSON.stringify({ title: 'Trois réflexes sur chantier', subtitle: null, bullets: ['Casque', 'Harnais', 'Balisage'], signature: 'Marie' }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: postId, asset_id: asset.id, position: 1 }).execute();
  });
});
afterAll(() => closeTestDatabase(db));

describe('carrousel PDF (VIS-10)', () => {
  it('couverture puis une page par point', () => {
    expect(carouselPages({ title: 'T', subtitle: null, bullets: ['a', 'b'], signature: 'S' })).toEqual([
      { title: 'T', subtitle: 'S' },
      { title: 'a', subtitle: '1 / 2' },
      { title: 'b', subtitle: '2 / 2' },
    ]);
  });

  it('PDF de 4 pages, qui remplace le visuel du post', async () => {
    const assetId = await makeCarousel(db, media, editor, postId, NOW);
    const asset = await asSystem(db, (trx) => trx.selectFrom('media_assets').select(['mime', 'storage_key']).where('id', '=', assetId).executeTakeFirstOrThrow());
    expect(asset.mime).toBe('application/pdf');
    const pdf = await PDFDocument.load(files.get(asset.storage_key) as Uint8Array);
    expect(pdf.getPageCount()).toBe(4);
    const linked = await asSystem(db, (trx) => trx.selectFrom('post_media').select(['asset_id', 'alt_text']).where('post_id', '=', postId).execute());
    expect(linked).toEqual([{ asset_id: assetId, alt_text: 'Trois réflexes sur chantier' }]);
    // Plus de visuel à points clés : un second carrousel n'est pas possible.
    await expect(makeCarousel(db, media, editor, postId, NOW)).rejects.toMatchObject({ code: 'carrousel_impossible' });
  });

  it('un post validé repasse en validation si une personne non déléguée crée le carrousel (RÈG-07)', async () => {
    const accountId = await createAccount(db, workspaceId);
    const validated = await createPost(db, workspaceId, accountId, { status: 'valide', scheduled_at: new Date('2026-12-02T10:00:00Z') });
    await asSystem(db, async (trx) => {
      const asset = await trx
        .insertInto('media_assets')
        .values({ workspace_id: workspaceId, kind: 'rendered', storage_key: `${workspaceId}/visuels/w.png`, mime: 'image/png', render_content: JSON.stringify({ title: 'Titre', subtitle: null, bullets: ['Un', 'Deux'], signature: 'S' }) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: validated, asset_id: asset.id, position: 1 }).execute();
    });
    await makeCarousel(db, media, editor, validated, NOW);
    expect(await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', validated).executeTakeFirstOrThrow())).toEqual({ status: 'a_valider' });
  });
});

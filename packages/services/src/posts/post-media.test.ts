import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { addPostPhotos, movePostPhoto, removePostPhoto } from './post-media.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
const people = { holder: '', editor: '', viewer: '' };
const NOW = new Date('2026-11-16T09:00:00Z');
const stored = new Map<string, Uint8Array>();
const media: MediaWriter = { write: async (key, bytes) => void stored.set(key, bytes) };
const gif = (label: string) => ({ bytes: new Uint8Array(Buffer.from(`GIF89a${label}`)), altText: label });

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.holder, 'contributor');
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder });
});
afterAll(() => closeTestDatabase(db));

let slot = 0;
const newPost = (values: Parameters<typeof createPost>[3] = {}) => {
  slot += 1;
  return createPost(db, workspaceId, accountId, { scheduled_at: new Date(Date.UTC(2026, 10, 17 + slot, 11)), ...values });
};

const order = (postId: string) =>
  asSystem(db, (trx) =>
    trx
      .selectFrom('post_media')
      .select(['alt_text', 'position', 'asset_id'])
      .where('post_id', '=', postId)
      .orderBy('position')
      .execute(),
  );

describe('photos d’un post (VIS-09, VIS-13, REC-11)', () => {
  it('le titulaire ajoute des photos, à la suite des existantes, nettoyées et stockées', async () => {
    const postId = await newPost();
    expect(await addPostPhotos(db, media, people.holder, postId, [gif('A'), gif('B')], NOW)).toBe(2);
    expect(await addPostPhotos(db, media, people.holder, postId, [gif('C')], NOW)).toBe(3);
    expect((await order(postId)).map((p) => [p.alt_text, p.position])).toEqual([
      ['A', 1],
      ['B', 2],
      ['C', 3],
    ]);
  });

  it('change l’ordre avec les flèches : la photo choisie devient la couverture', async () => {
    const postId = await newPost();
    await addPostPhotos(db, media, people.holder, postId, [gif('A'), gif('B'), gif('C')], NOW);
    const c = (await order(postId))[2]?.asset_id as string;
    await movePostPhoto(db, people.holder, postId, c, 'up', NOW);
    await movePostPhoto(db, people.holder, postId, c, 'up', NOW);
    await movePostPhoto(db, people.holder, postId, c, 'up', NOW); // déjà en tête : sans effet
    expect((await order(postId)).map((p) => p.alt_text)).toEqual(['C', 'A', 'B']);
  });

  it('retire une photo et renumérote les autres', async () => {
    const postId = await newPost();
    await addPostPhotos(db, media, people.holder, postId, [gif('A'), gif('B'), gif('C')], NOW);
    await removePostPhoto(db, people.holder, postId, (await order(postId))[0]?.asset_id as string, NOW);
    expect((await order(postId)).map((p) => [p.alt_text, p.position])).toEqual([
      ['B', 1],
      ['C', 2],
    ]);
  });

  it('refuse au-delà de 9 photos, et ce qui n’est pas une image', async () => {
    const postId = await newPost();
    await addPostPhotos(db, media, people.holder, postId, Array.from({ length: 8 }, (_, i) => gif(`${i}`)), NOW);
    await expect(addPostPhotos(db, media, people.holder, postId, [gif('9'), gif('10')], NOW)).rejects.toMatchObject({ code: 'too_many_images' });
    await expect(addPostPhotos(db, media, people.holder, postId, [{ bytes: new Uint8Array(Buffer.from('%PDF-1.7')) }], NOW)).rejects.toMatchObject({
      code: 'image_unsupported',
    });
  });

  it('un éditeur non délégué qui change les photos d’un post validé le renvoie en validation (RÈG-07)', async () => {
    const postId = await newPost({ status: 'valide' });
    await addPostPhotos(db, media, people.editor, postId, [gif('A')], NOW);
    const post = await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', postId).executeTakeFirstOrThrow());
    expect(post.status).toBe('a_valider');
  });

  it('un lecteur ne peut pas modifier les photos ; un post publié ne se modifie plus', async () => {
    const postId = await newPost();
    await expect(addPostPhotos(db, media, people.viewer, postId, [gif('A')], NOW)).rejects.toBeInstanceOf(ForbiddenError);
    const published = await newPost({ status: 'publie', published_at: NOW, external_post_urn: 'urn:li:share:1' });
    await expect(addPostPhotos(db, media, people.holder, published, [gif('A')], NOW)).rejects.toMatchObject({ code: 'not_editable' });
  });
});

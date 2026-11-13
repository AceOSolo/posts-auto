import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, RefusedError } from '../errors.ts';
import { getPostDetail } from '../posts/post-queries.ts';
import { VISUAL_REDO_MAX_PER_HOUR, requestVisualRedo } from './visual-requests.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
const people = { holder: '', editor: '', viewer: '', busy: '' };
const NOW = new Date('2026-11-16T09:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.holder, 'contributor');
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  await addMember(db, workspaceId, people.busy, 'editor');
  accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder });
});
afterAll(() => closeTestDatabase(db));

let slot = 0;
const newPost = (values: Parameters<typeof createPost>[3] = {}) => {
  slot += 1;
  return createPost(db, workspaceId, accountId, { scheduled_at: new Date(Date.UTC(2026, 10, 17 + slot, 11)), ...values });
};

async function attach(postId: string, kind: 'rendered' | 'upload', content: Record<string, unknown> | null = null, position = 1): Promise<string> {
  return asSystem(db, async (trx) => {
    const asset = await trx
      .insertInto('media_assets')
      .values({
        workspace_id: workspaceId,
        kind,
        storage_key: `test/${postId}/${kind}-${position}.png`,
        mime: 'image/png',
        ai_generated: content?.['photo'] === 'generated',
        render_content: content === null ? null : JSON.stringify(content),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: postId, asset_id: asset.id, position }).execute();
    return asset.id;
  });
}

const taskOf = (postId: string) => asSystem(db, (trx) => trx.selectFrom('visual_tasks').selectAll().where('post_id', '=', postId).executeTakeFirst());

describe('refaire le visuel (VIS-13)', () => {
  it('le titulaire demande un nouveau visuel, avec une consigne et sans photo', async () => {
    const postId = await newPost();
    await attach(postId, 'rendered', { title: 'T', photo: 'generated', issues: [{ code: 'text_truncated', zone: 'titre' }], notes: [] });
    await requestVisualRedo(db, people.holder, postId, { instruction: '  Un titre   plus court ', photoMode: 'none' }, NOW);
    expect(await taskOf(postId)).toMatchObject({ reason: 'redo', instruction: 'Un titre plus court', photo_mode: 'none', requested_by: people.holder, attempts: 0 });

    const detail = await getPostDetail(db, people.holder, postId, NOW);
    expect(detail.visualTask).toMatchObject({ status: 'pending', instruction: 'Un titre plus court', photoMode: 'none' });
    expect(detail.actions.canRedoVisual).toBe(true);
    expect(detail.media[0]).toMatchObject({ kind: 'rendered', aiGenerated: true, visual: { photo: 'generated', issues: ['Texte trop long, coupé (zone « titre »)'] } });
  });

  it('sur un post sans visuel, la demande en ajoute un', async () => {
    const postId = await newPost();
    await requestVisualRedo(db, people.holder, postId, { photoMode: 'keep' }, NOW);
    expect(await taskOf(postId)).toMatchObject({ reason: 'new', instruction: null });
  });

  it('une nouvelle demande relance une tâche en échec', async () => {
    const postId = await newPost();
    await requestVisualRedo(db, people.holder, postId, { photoMode: 'new' }, NOW);
    await asSystem(db, (trx) => trx.updateTable('visual_tasks').set({ failed_at: NOW, error: 'panne', attempts: 3 }).where('post_id', '=', postId).execute());
    expect((await getPostDetail(db, people.holder, postId, NOW)).visualTask).toMatchObject({ status: 'failed', error: 'panne' });
    await requestVisualRedo(db, people.holder, postId, { instruction: 'Plus lumineux', photoMode: 'new' }, NOW);
    expect(await taskOf(postId)).toMatchObject({ failed_at: null, error: null, attempts: 0, instruction: 'Plus lumineux' });
  });

  it('RÈG-07 : une éditrice qui refait le visuel d’un post validé le renvoie en validation', async () => {
    const postId = await newPost({ status: 'valide' });
    await requestVisualRedo(db, people.editor, postId, { photoMode: 'keep' }, NOW);
    const post = await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', postId).executeTakeFirstOrThrow());
    expect(post.status).toBe('a_valider');
  });

  it('refuse un lecteur, un post parti et un post qui a déjà neuf images', async () => {
    const postId = await newPost();
    await expect(requestVisualRedo(db, people.viewer, postId, { photoMode: 'keep' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    const gone = await newPost({ status: 'en_publication' });
    await expect(requestVisualRedo(db, people.holder, gone, { photoMode: 'keep' }, NOW)).rejects.toMatchObject({ code: 'not_editable' });
    const full = await newPost();
    for (let i = 1; i <= 9; i += 1) await attach(full, 'upload', null, i);
    await expect(requestVisualRedo(db, people.holder, full, { photoMode: 'keep' }, NOW)).rejects.toMatchObject({ code: 'too_many_images' });
  });

  it(`au plus ${VISUAL_REDO_MAX_PER_HOUR} demandes par personne et par heure`, async () => {
    const postId = await newPost();
    for (let i = 0; i < VISUAL_REDO_MAX_PER_HOUR; i += 1) await requestVisualRedo(db, people.busy, postId, { photoMode: 'keep' }, NOW);
    const refused = requestVisualRedo(db, people.busy, postId, { photoMode: 'keep' }, NOW);
    await expect(refused).rejects.toBeInstanceOf(RefusedError);
    await expect(refused).rejects.toMatchObject({ code: 'trop_de_visuels' });
    await requestVisualRedo(db, people.busy, postId, { photoMode: 'keep' }, new Date(NOW.getTime() + 3_600_001));
  });
});

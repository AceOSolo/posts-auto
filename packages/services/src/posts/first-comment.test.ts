import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFirstComment } from './post-queries.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
let holder: string;
let editor: string;
const NOW = new Date('2026-11-16T09:00:00Z');
let slot = 0;
const newPost = (status: 'a_valider' | 'valide') => createPost(db, workspaceId, accountId, { status, scheduled_at: new Date(Date.UTC(2026, 10, 18 + (slot += 1), 11)) });
const read = (postId: string) => asSystem(db, (trx) => trx.selectFrom('posts').select(['status', 'first_comment']).where('id', '=', postId).executeTakeFirstOrThrow());

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  holder = await createUser(db, 'titulaire');
  editor = await createUser(db, 'editeur');
  await addMember(db, workspaceId, holder, 'contributor');
  await addMember(db, workspaceId, editor, 'editor');
  accountId = await createAccount(db, workspaceId, { holder_user_id: holder });
});
afterAll(() => closeTestDatabase(db));

describe('premier commentaire (PUB-07, RÈG-07, VAL-03)', () => {
  it('changé par une personne non déléguée : le post validé repasse en validation', async () => {
    const postId = await newPost('valide');
    await setFirstComment(db, editor, postId, 'Le lien en commentaire.', NOW);
    expect(await read(postId)).toEqual({ status: 'a_valider', first_comment: 'Le lien en commentaire.' });
  });

  it('changé par le titulaire : le post reste validé', async () => {
    const postId = await newPost('valide');
    await setFirstComment(db, holder, postId, 'Mon commentaire.', NOW);
    expect(await read(postId)).toEqual({ status: 'valide', first_comment: 'Mon commentaire.' });
  });

  it('enregistré sans changement : aucune nouvelle validation', async () => {
    const postId = await newPost('valide');
    await setFirstComment(db, holder, postId, 'Identique.', NOW);
    await setFirstComment(db, editor, postId, 'Identique.', NOW);
    expect((await read(postId)).status).toBe('valide');
  });

  it('refuse un commentaire qui contient un marqueur bloquant', async () => {
    const postId = await newPost('a_valider');
    await expect(setFirstComment(db, holder, postId, 'Voir [À COMPLÉTER : lien]', NOW)).rejects.toMatchObject({ code: 'blocking_markers' });
    expect((await read(postId)).first_comment).toBeNull();
  });
});

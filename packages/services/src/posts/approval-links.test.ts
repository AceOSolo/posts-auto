import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../auth/auth.ts';
import { confirmApprovalLink, createApprovalLink, previewApprovalLink } from './approval-links.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
let holder: string;
let editor: string;
const NOW = new Date('2026-11-16T09:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  holder = await createUser(db, 'titulaire');
  editor = await createUser(db, 'editeur');
  await addMember(db, workspaceId, holder, 'contributor');
  await addMember(db, workspaceId, editor, 'editor');
  accountId = await createAccount(db, workspaceId, { holder_user_id: holder, display_name: 'JP' });
});
afterAll(() => closeTestDatabase(db));

let slot = 0;
const newPost = (values: Parameters<typeof createPost>[3] = {}) => {
  slot += 1;
  return createPost(db, workspaceId, accountId, { scheduled_at: new Date(Date.UTC(2026, 10, 17 + slot, 11)), ...values });
};
const status = (postId: string) => asSystem(db, (trx) => trx.selectFrom('posts').select(['status', 'decided_by']).where('id', '=', postId).executeTakeFirstOrThrow());

describe('validation depuis l’e-mail (VAL-06, REC-14)', () => {
  it('ouvrir le lien ne valide rien (antivirus de messagerie) ; seul « Confirmer » valide', async () => {
    const postId = await newPost({ body: 'Texte prêt.' });
    const token = await createApprovalLink(db, postId, holder, NOW);
    for (let i = 0; i < 3; i += 1) expect(await previewApprovalLink(db, token, NOW)).toMatchObject({ pending: true, accountName: 'JP', body: 'Texte prêt.' });
    expect((await status(postId)).status).toBe('a_valider');

    expect(await confirmApprovalLink(db, token, NOW)).toMatchObject({ ok: true, departsNow: false });
    expect(await status(postId)).toEqual({ status: 'valide', decided_by: holder });
  });

  it('le lien ne sert qu’une fois', async () => {
    const postId = await newPost();
    const token = await createApprovalLink(db, postId, holder, NOW);
    await confirmApprovalLink(db, token, NOW);
    expect(await confirmApprovalLink(db, token, NOW)).toEqual({ ok: false, reason: 'lien_invalide' });
    expect(await previewApprovalLink(db, token, NOW)).toBeNull();
  });

  it('expire au créneau du post, et au plus tard 7 jours après l’envoi', async () => {
    const soon = await newPost();
    const soonToken = await createApprovalLink(db, soon, holder, NOW);
    const slotOf = (await asSystem(db, (trx) => trx.selectFrom('posts').select('scheduled_at').where('id', '=', soon).executeTakeFirstOrThrow())).scheduled_at;
    expect(await previewApprovalLink(db, soonToken, new Date(slotOf.getTime() + 1))).toBeNull();

    const far = await createPost(db, workspaceId, accountId, { scheduled_at: new Date('2027-01-15T11:00:00Z') });
    const farToken = await createApprovalLink(db, far, holder, NOW);
    const link = await asSystem(db, (trx) => trx.selectFrom('approval_links').select('expires_at').where('token_hash', '=', hashToken(farToken)).executeTakeFirstOrThrow());
    expect(link.expires_at.toISOString()).toBe('2026-11-23T09:00:00.000Z');
  });

  it('refuse la validation tant qu’un passage reste à compléter', async () => {
    const postId = await newPost({ body: 'Le [À COMPLÉTER : date].' });
    const token = await createApprovalLink(db, postId, holder, NOW);
    expect(await previewApprovalLink(db, token, NOW)).toMatchObject({ hasBlockingMarkers: true });
    expect(await confirmApprovalLink(db, token, NOW)).toEqual({ ok: false, reason: 'a_completer' });
    expect((await status(postId)).status).toBe('a_valider');
  });

  it('un post déjà traité par ailleurs : le lien n’a plus d’effet', async () => {
    const postId = await newPost({ status: 'valide' });
    const token = await createApprovalLink(db, postId, holder, NOW);
    expect(await previewApprovalLink(db, token, NOW)).toMatchObject({ pending: false });
    expect(await confirmApprovalLink(db, token, NOW)).toEqual({ ok: false, reason: 'deja_traite' });
  });

  it('valide sous l’identité du destinataire : un éditeur non délégué n’y gagne aucun droit', async () => {
    const postId = await newPost();
    const token = await createApprovalLink(db, postId, editor, NOW);
    expect(await confirmApprovalLink(db, token, NOW)).toEqual({ ok: false, reason: 'plus_autorise' });
    expect((await status(postId)).status).toBe('a_valider');
  });

  it('un jeton inventé ou mal formé est refusé', async () => {
    expect(await previewApprovalLink(db, 'x'.repeat(43), NOW)).toBeNull();
    expect(await confirmApprovalLink(db, 'court', NOW)).toEqual({ ok: false, reason: 'lien_invalide' });
  });
});

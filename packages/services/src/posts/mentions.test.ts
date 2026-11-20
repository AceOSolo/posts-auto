import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { DEFAULT_EDITORIAL_RULES, checkPostText } from '@posts-auto/core';
import { FakeLinkedInPages } from '@posts-auto/linkedin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { resolvePageMention } from './mentions.ts';

let db: Database;
let editor: string;
let viewer: string;
let postId: string;
const cipher = { encrypt: (p: string, b: string) => Buffer.from(`${b}|${p}`), decrypt: (payload: Uint8Array) => Buffer.from(payload).toString().split('|')[1] as string };

beforeAll(async () => {
  db = await openTestDatabase();
  const workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  editor = await createUser(db, 'mention-editor');
  viewer = await createUser(db, 'mention-viewer');
  await addMember(db, workspaceId, editor, 'editor');
  await addMember(db, workspaceId, viewer, 'viewer');
  const accountId = await createAccount(db, workspaceId);
  await asSystem(db, (trx) =>
    trx.insertInto('social_tokens').values({ account_id: accountId, workspace_id: workspaceId, oauth_client_id: 'a', access_token_enc: cipher.encrypt('T', accountId), scopes: [], expires_at: new Date(Date.now() + 86_400_000) }).execute(),
  );
  postId = await createPost(db, workspaceId, accountId, { scheduled_at: new Date('2026-12-01T10:00:00Z') });
});
afterAll(() => closeTestDatabase(db));

describe('mention d’une page (PUB-08)', () => {
  it('adresse de page → mention au format de l’API, qui passe les règles ; un @ tapé reste signalé', async () => {
    const deps = { pages: new FakeLinkedInPages(), cipher };
    const found = await resolvePageMention(db, deps, editor, postId, 'https://www.linkedin.com/company/secutop/');
    expect(found.mention).toMatch(/^@\[Secutop\]\(urn:li:organization:\d+\)$/);
    await expect(resolvePageMention(db, deps, editor, postId, 'https://exemple.fr/secutop')).rejects.toMatchObject({ code: 'page_mention_invalide' });
    await expect(resolvePageMention(db, deps, editor, postId, 'https://www.linkedin.com/company/inconnue')).rejects.toMatchObject({ code: 'page_introuvable' });
    await expect(resolvePageMention(db, deps, viewer, postId, 'https://www.linkedin.com/company/secutop')).rejects.toBeInstanceOf(ForbiddenError);
    const codes = (text: string) => checkPostText(text, DEFAULT_EDITORIAL_RULES).map((i) => i.code);
    expect(codes(`Bravo ${found.mention} pour ce chantier.`)).not.toContain('mention');
    expect(codes('Bravo @secutop pour ce chantier.')).toContain('mention');
  });
});

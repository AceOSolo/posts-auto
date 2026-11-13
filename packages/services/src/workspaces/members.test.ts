import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { decidePost } from '../posts/post-actions.ts';
import { changeMemberRole, inviteMember, listDelegates, listMembers, removeMember, setAccountPaused, setDelegates } from './members.ts';

let db: Database;
let workspaceId: string;
let ownerId: string;
const people = { admin: '', editor: '', holder: '' };
const NOW = new Date('2026-11-16T09:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  ownerId = org.ownerId;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.admin, 'admin');
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.holder, 'contributor');
});
afterAll(() => closeTestDatabase(db));

describe('invitations (ONB-07)', () => {
  it('l’admin invite une nouvelle personne : utilisateur créé, membre avec son rôle, trace d’audit', async () => {
    const result = await inviteMember(db, people.admin, workspaceId, { email: ' Claire.Durand@Exemple.TEST ', fullName: 'Claire Durand', role: 'contributor' }, NOW);
    expect(result).toMatchObject({ email: 'claire.durand@exemple.test', alreadyMember: false });
    const { members } = await listMembers(db, people.admin, workspaceId);
    expect(members.find((m) => m.userId === result.userId)).toMatchObject({ role: 'contributor', fullName: 'Claire Durand' });
  });

  it('réinviter un membre ne change ni son rôle ni son nom', async () => {
    const first = await inviteMember(db, people.admin, workspaceId, { email: 'reinvite@exemple.test', fullName: 'Nom 1', role: 'viewer' }, NOW);
    const again = await inviteMember(db, people.admin, workspaceId, { email: 'reinvite@exemple.test', fullName: 'Nom 2', role: 'admin' }, NOW);
    expect(again).toMatchObject({ userId: first.userId, alreadyMember: true });
    const member = (await listMembers(db, people.admin, workspaceId)).members.find((m) => m.userId === first.userId);
    expect(member).toMatchObject({ role: 'viewer', fullName: 'Nom 1' });
  });

  it('un éditeur ne peut pas inviter ; le propriétaire de l’organisation le peut', async () => {
    await expect(inviteMember(db, people.editor, workspaceId, { email: 'x@exemple.test', role: 'viewer' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(inviteMember(db, ownerId, workspaceId, { email: 'par-proprietaire@exemple.test', role: 'viewer' }, NOW)).resolves.toMatchObject({ alreadyMember: false });
  });

  it('refuse une adresse invalide', async () => {
    await expect(inviteMember(db, people.admin, workspaceId, { email: 'pas-une-adresse', role: 'viewer' }, NOW)).rejects.toMatchObject({ code: 'email_invalide' });
  });
});

describe('rôles et départs', () => {
  it('change un rôle, mais jamais celui du dernier administrateur', async () => {
    await changeMemberRole(db, people.admin, workspaceId, people.editor, 'viewer', NOW);
    expect((await listMembers(db, people.admin, workspaceId)).members.find((m) => m.userId === people.editor)?.role).toBe('viewer');
    await expect(changeMemberRole(db, people.admin, workspaceId, people.admin, 'editor', NOW)).rejects.toMatchObject({ code: 'dernier_admin' });
    await changeMemberRole(db, people.admin, workspaceId, people.editor, 'editor', NOW);
  });

  it('retirer une personne lui retire aussi ses délégations', async () => {
    const leaving = await inviteMember(db, people.admin, workspaceId, { email: 'depart@exemple.test', role: 'editor' }, NOW);
    const accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder });
    await setDelegates(db, people.admin, accountId, [leaving.userId], NOW);
    await removeMember(db, people.admin, workspaceId, leaving.userId, NOW);
    expect(await listDelegates(db, people.admin, accountId)).toEqual([]);
    expect((await listMembers(db, people.admin, workspaceId)).members.some((m) => m.userId === leaving.userId)).toBe(false);
  });
});

describe('délégués (ROL-01)', () => {
  it('l’admin désigne les délégués, qui peuvent alors valider à la place du titulaire', async () => {
    const accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder });
    await setDelegates(db, people.admin, accountId, [people.editor, people.holder], NOW);
    expect(await listDelegates(db, people.admin, accountId)).toEqual([people.editor]); // le titulaire n'est pas son propre délégué
    const postId = await createPost(db, workspaceId, accountId, { scheduled_at: new Date('2026-11-18T11:00:00Z') });
    await expect(decidePost(db, people.editor, postId, { type: 'validate' }, NOW)).resolves.toMatchObject({ status: 'valide' });
  });

  it('refuse un délégué extérieur à l’espace, et un éditeur qui voudrait se désigner', async () => {
    const accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder });
    const outsider = await createUser(db, 'exterieur');
    await expect(setDelegates(db, people.admin, accountId, [outsider], NOW)).rejects.toMatchObject({ code: 'delegue_hors_espace' });
    await expect(setDelegates(db, people.editor, accountId, [people.editor], NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('pause d’un compte (LNK-07, RÈG-21)', () => {
  it('met en pause puis reprend selon l’état réel de la connexion', async () => {
    const accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder });
    expect(await setAccountPaused(db, people.admin, accountId, true, NOW)).toBe('paused');
    expect(await setAccountPaused(db, people.admin, accountId, false, NOW)).toBe('expired'); // aucun jeton
    await asSystem(db, (trx) =>
      trx
        .insertInto('social_tokens')
        .values({ account_id: accountId, workspace_id: workspaceId, oauth_client_id: 'a', access_token_enc: Buffer.from('x'), scopes: [], expires_at: new Date('2027-01-01T00:00:00Z') })
        .execute(),
    );
    await setAccountPaused(db, people.admin, accountId, true, NOW);
    expect(await setAccountPaused(db, people.admin, accountId, false, NOW)).toBe('connected');
  });

  it('seul un administrateur peut mettre un compte en pause', async () => {
    const accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder });
    await expect(setAccountPaused(db, people.holder, accountId, true, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

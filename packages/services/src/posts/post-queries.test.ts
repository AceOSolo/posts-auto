import { type Database, asSystem } from '@posts-auto/db';
import {
  addMember,
  closeTestDatabase,
  createAccount,
  createOrganization,
  createPost,
  createUser,
  openTestDatabase,
} from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors.ts';
import { getPostDetail, listMyPosts, listMyWorkspaces, teamWeek } from './post-queries.ts';

let db: Database;
let workspaceId: string;
let jpAccount: string;
let pageAccount: string;
const people = { jp: '', alice: '', viewer: '', outsider: '' };
const NOW = new Date('2026-11-16T09:00:00Z'); // lundi 10h00

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db, { name: 'Secutop' });
  workspaceId = org.workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.jp, 'contributor');
  await addMember(db, workspaceId, people.alice, 'editor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  const other = await createOrganization(db);
  await addMember(db, other.workspaceIds[0] as string, people.outsider, 'admin');

  jpAccount = await createAccount(db, workspaceId, { holder_user_id: people.jp, display_name: 'JP' });
  pageAccount = await createAccount(db, workspaceId, { holder_user_id: people.jp, kind: 'page', display_name: 'Page Secutop' });
  await asSystem(db, (trx) =>
    trx.insertInto('account_delegates').values({ account_id: pageAccount, workspace_id: workspaceId, user_id: people.alice }).execute(),
  );
});
afterAll(() => closeTestDatabase(db));

describe('« Mes posts » (VAL-01)', () => {
  it('liste les posts des comptes du titulaire, par heure de départ, avec la phrase de départ', async () => {
    const later = await createPost(db, workspaceId, jpAccount, { scheduled_at: new Date('2026-11-19T08:00:00Z') });
    const sooner = await createPost(db, workspaceId, jpAccount, { scheduled_at: new Date('2026-11-17T11:00:00Z') });
    const posts = (await listMyPosts(db, people.jp, NOW)).filter((p) => [later, sooner].includes(p.id));
    expect(posts.map((p) => p.id)).toEqual([sooner, later]);
    expect(posts[0]).toMatchObject({ accountName: 'JP', departure: 'Partira demain à 12h si validé', isMine: true });
  });

  it('montre au délégué les posts des comptes qui lui sont délégués, et seulement ceux-là', async () => {
    const pagePost = await createPost(db, workspaceId, pageAccount, { scheduled_at: new Date('2026-11-18T11:00:00Z') });
    const jpPost = await createPost(db, workspaceId, jpAccount, { scheduled_at: new Date('2026-11-18T13:00:00Z') });
    const ids = (await listMyPosts(db, people.alice, NOW)).map((p) => p.id);
    expect(ids).toContain(pagePost);
    expect(ids).not.toContain(jpPost);
  });

  it('ne montre rien à un lecteur, qui n’est titulaire de rien', async () => {
    expect(await listMyPosts(db, people.viewer, NOW)).toEqual([]);
  });
});

describe('détail d’un post', () => {
  it('donne les versions, l’historique, les marqueurs à surligner et les actions permises', async () => {
    const postId = await createPost(db, workspaceId, jpAccount, {
      scheduled_at: new Date('2026-11-20T11:00:00Z'),
      body: 'Webinaire le [À COMPLÉTER : date].',
    });
    const detail = await getPostDetail(db, people.jp, postId, NOW);
    expect(detail.markers).toEqual([{ start: 13, end: 33, text: '[À COMPLÉTER : date]' }]);
    expect(detail.versions).toHaveLength(1);
    expect(detail.actions).toEqual({ commands: ['validate', 'requestChanges', 'refuse'], canEdit: true, canReschedule: true, canRedoVisual: true });
    expect(detail.visualTask).toBeNull();
  });

  it('un lecteur voit le post mais n’a aucune action', async () => {
    const postId = await createPost(db, workspaceId, jpAccount, { scheduled_at: new Date('2026-11-23T11:00:00Z') });
    const detail = await getPostDetail(db, people.viewer, postId, NOW);
    expect(detail.actions).toEqual({ commands: [], canEdit: false, canReschedule: false, canRedoVisual: false });
    expect(detail.isMine).toBe(false);
  });

  it('une personne d’un autre client ne le trouve pas (REC-01)', async () => {
    const postId = await createPost(db, workspaceId, jpAccount, { scheduled_at: new Date('2026-11-24T11:00:00Z') });
    await expect(getPostDetail(db, people.outsider, postId, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('vue équipe (VAL-07) et espaces', () => {
  it('range les posts de la semaine par compte', async () => {
    const week = await teamWeek(db, people.alice, workspaceId, '2026-11-16', NOW);
    expect(week.map((a) => a.accountName).sort()).toEqual(['JP', 'Page Secutop']);
    const page = week.find((a) => a.accountName === 'Page Secutop');
    expect(page?.posts.every((p) => p.isMine)).toBe(true);
    const jp = week.find((a) => a.accountName === 'JP');
    expect(jp?.posts.length).toBeGreaterThan(0);
    expect(jp?.posts.every((p) => !p.isMine)).toBe(true);
  });

  it('ne liste que les espaces de la personne', async () => {
    expect((await listMyWorkspaces(db, people.alice)).map((w) => w.role)).toEqual(['editor']);
    expect((await listMyWorkspaces(db, people.outsider)).map((w) => w.id)).not.toContain(workspaceId);
  });
});

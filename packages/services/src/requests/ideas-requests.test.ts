import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import type { MediaWriter } from '../exchange/exchange.ts';
import { createPostRequest, listIdeas, listPostRequests, saveIdea, setIdeaStatus } from './ideas-requests.ts';

let db: Database;
let workspaceId: string;
let jp: string;
let page: string;
let foreign: string;
const people = { editor: '', contributor: '', other: '', viewer: '', stranger: '' };
const NOW = new Date('2026-11-16T09:00:00Z');
const stored = new Map<string, Uint8Array>();
const media: MediaWriter = { write: async (key, bytes) => void stored.set(key, bytes) };
const gif = (label: string) => ({ bytes: new Uint8Array(Buffer.from(`GIF89a${label}`)) });

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  const otherWorkspace = (await createOrganization(db)).workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.contributor, 'contributor');
  await addMember(db, workspaceId, people.other, 'contributor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  await addMember(db, otherWorkspace, people.stranger, 'admin');
  jp = await createAccount(db, workspaceId, { display_name: 'JP' });
  page = await createAccount(db, workspaceId, { display_name: 'Page', kind: 'page' });
  foreign = await createAccount(db, otherWorkspace);
});
afterAll(() => closeTestDatabase(db));

describe('idées (IDE-01)', () => {
  it('une contributrice propose une idée ; elle et la gestion du contenu peuvent la modifier, pas une autre contributrice', async () => {
    const id = await saveIdea(db, people.contributor, workspaceId, null, { title: ' Salon Preventica ', details: 'Stand B12', link: 'https://preventica.com', eventOn: '2026-12-08', accountIds: [jp] }, NOW);
    const { ideas } = await listIdeas(db, people.other, workspaceId);
    expect(ideas.find((i) => i.id === id)).toMatchObject({ title: 'Salon Preventica', eventOn: '2026-12-08', accountIds: [jp], allAccounts: false, status: 'new', authorName: 'contributor', canEdit: false });
    expect((await listIdeas(db, people.contributor, workspaceId)).ideas.find((i) => i.id === id)?.canEdit).toBe(true);
    await expect(saveIdea(db, people.other, workspaceId, id, { title: 'Détournée', accountIds: [] }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await saveIdea(db, people.editor, workspaceId, id, { title: 'Salon Preventica 2026', accountIds: [] }, NOW);
    expect((await listIdeas(db, people.editor, workspaceId)).ideas.find((i) => i.id === id)).toMatchObject({ title: 'Salon Preventica 2026', allAccounts: true, accountIds: [] });
  });

  it('la gestion du contenu retient ou écarte ; une idée utilisée ne change plus', async () => {
    const id = await saveIdea(db, people.contributor, workspaceId, null, { title: 'Idée à trier', accountIds: [] }, NOW);
    await expect(setIdeaStatus(db, people.contributor, workspaceId, id, 'kept', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await setIdeaStatus(db, people.editor, workspaceId, id, 'dismissed', NOW);
    expect((await listIdeas(db, people.editor, workspaceId)).ideas.map((i) => i.id)).not.toContain(id);
    expect((await listIdeas(db, people.editor, workspaceId, ['dismissed'])).ideas.map((i) => i.id)).toContain(id);

    await asSystem(db, (trx) => trx.updateTable('ideas').set({ status: 'used' }).where('id', '=', id).execute());
    const postId = await createPost(db, workspaceId, jp, { idea_id: id, origin: 'team_idea' });
    expect((await listIdeas(db, people.editor, workspaceId, ['used'])).ideas.find((i) => i.id === id)?.posts).toEqual([{ id: postId, status: 'a_valider' }]);
    await expect(setIdeaStatus(db, people.editor, workspaceId, id, 'kept', NOW)).rejects.toMatchObject({ code: 'idee_utilisee' });
    await expect(saveIdea(db, people.editor, workspaceId, id, { title: 'x', accountIds: [] }, NOW)).rejects.toMatchObject({ code: 'idee_utilisee' });
  });

  it('contrôles : lecteur, dates, semaine, compte étranger, autre client', async () => {
    await expect(saveIdea(db, people.viewer, workspaceId, null, { title: 'x', accountIds: [] }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveIdea(db, people.editor, workspaceId, null, { title: ' ', accountIds: [] }, NOW)).rejects.toMatchObject({ code: 'titre_requis' });
    await expect(saveIdea(db, people.editor, workspaceId, null, { title: 'x', startsOn: '2026-12-10', endsOn: '2026-12-01', accountIds: [] }, NOW)).rejects.toMatchObject({ code: 'date_fin_invalide' });
    await expect(saveIdea(db, people.editor, workspaceId, null, { title: 'x', targetWeek: '2026-11-18', accountIds: [] }, NOW)).rejects.toMatchObject({ code: 'semaine_invalide' });
    await expect(saveIdea(db, people.editor, workspaceId, null, { title: 'x', eventOn: '2026-13-01', accountIds: [] }, NOW)).rejects.toMatchObject({ code: 'date_invalide' });
    await expect(saveIdea(db, people.editor, workspaceId, null, { title: 'x', accountIds: [foreign] }, NOW)).rejects.toMatchObject({ code: 'compte_inconnu' });
    await expect(listIdeas(db, people.stranger, workspaceId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('demandes de post (IDE-03, IDE-06)', () => {
  it('une contributrice dépose une demande avec photos dans l’ordre ; elle en voit le suivi', async () => {
    const id = await createPostRequest(
      db,
      media,
      people.contributor,
      workspaceId,
      {
        rawText: 'Post sur notre nouvelle salle de formation, mardi prochain',
        links: 'https://secutop.fr/salle\nmauvais lien\nhttps://secutop.fr/salle',
        wishedAt: new Date('2026-11-24T11:00:00Z'),
        accountIds: [page, jp, page],
        photos: [gif('1'), gif('2')],
      },
      NOW,
    );
    const { requests, canPropose } = await listPostRequests(db, people.contributor, workspaceId, { mine: true });
    expect(canPropose).toBe(true);
    expect(requests[0]).toMatchObject({ id, status: 'new', links: ['https://secutop.fr/salle'], photoCount: 2, isMine: true, authorName: 'contributor', posts: [] });
    expect(new Set(requests[0]?.accountIds)).toEqual(new Set([page, jp]));
    const photos = await asSystem(db, (trx) =>
      trx.selectFrom('request_photos as p').innerJoin('media_assets as m', 'm.id', 'p.asset_id').select(['p.position', 'm.storage_key']).where('p.request_id', '=', id).orderBy('p.position').execute(),
    );
    expect(photos.map((p) => p.position)).toEqual([1, 2]);
    expect(photos.every((p) => p.storage_key.startsWith(`${workspaceId}/demandes/${id}/`) && stored.has(p.storage_key))).toBe(true);

    const postId = await createPost(db, workspaceId, page, { request_id: id, origin: 'request', scheduled_at: new Date('2026-11-24T11:00:00Z'), week_start: '2026-11-23' });
    expect((await listPostRequests(db, people.editor, workspaceId)).requests.find((r) => r.id === id)).toMatchObject({ isMine: false, posts: [{ id: postId, accountId: page, status: 'a_valider' }] });
  });

  it('contrôles : texte, comptes, date trop proche, photo invalide, lecteur', async () => {
    const base = { rawText: 'Un post', accountIds: [jp] };
    await expect(createPostRequest(db, media, people.contributor, workspaceId, { ...base, rawText: ' ' }, NOW)).rejects.toMatchObject({ code: 'demande_vide' });
    await expect(createPostRequest(db, media, people.contributor, workspaceId, { ...base, accountIds: [] }, NOW)).rejects.toMatchObject({ code: 'compte_requis' });
    await expect(createPostRequest(db, media, people.contributor, workspaceId, { ...base, accountIds: [foreign] }, NOW)).rejects.toMatchObject({ code: 'compte_inconnu' });
    await expect(createPostRequest(db, media, people.contributor, workspaceId, { ...base, wishedAt: new Date(NOW.getTime() + 30 * 60_000) }, NOW)).rejects.toMatchObject({ code: 'date_trop_proche' });
    await expect(createPostRequest(db, media, people.contributor, workspaceId, { ...base, photos: [{ bytes: new Uint8Array([1, 2, 3]) }] }, NOW)).rejects.toMatchObject({ code: 'image_unsupported' });
    await expect(createPostRequest(db, media, people.contributor, workspaceId, { ...base, photos: Array.from({ length: 10 }, (_, i) => gif(String(i))) }, NOW)).rejects.toMatchObject({ code: 'too_many_images' });
    await expect(createPostRequest(db, media, people.viewer, workspaceId, base, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listPostRequests(db, people.viewer, workspaceId)).canPropose).toBe(false);
  });
});

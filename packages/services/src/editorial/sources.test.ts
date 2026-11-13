import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import { addSource, checkSourceUrl, deleteSource, listSources, setSourceEnabled } from './sources.ts';

let db: Database;
let workspaceId: string;
let editor: string;
let contributor: string;
let stranger: string;
const NOW = new Date('2026-11-16T09:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  editor = await createUser(db, 'editrice');
  contributor = await createUser(db, 'contributrice');
  stranger = await createUser(db, 'autre');
  await addMember(db, workspaceId, editor, 'editor');
  await addMember(db, workspaceId, contributor, 'contributor');
  await addMember(db, (await createOrganization(db)).workspaceIds[0] as string, stranger, 'admin');
});
afterAll(() => closeTestDatabase(db));

describe('sources de veille (GEN-09)', () => {
  it('l’éditrice ajoute, suspend et supprime une source ; les articles sont comptés', async () => {
    const id = await addSource(db, editor, workspaceId, { url: ' https://www.inrs.fr/rss/actualites.xml ', label: 'INRS' }, NOW);
    await asSystem(db, (trx) =>
      trx
        .insertInto('source_items')
        .values([
          { workspace_id: workspaceId, source_id: id, guid: 'a', title: 'Article A' },
          { workspace_id: workspaceId, source_id: id, guid: 'b', title: 'Article B' },
        ])
        .execute(),
    );
    const { sources, canEdit } = await listSources(db, contributor, workspaceId);
    expect(canEdit).toBe(false);
    expect(sources).toEqual([expect.objectContaining({ id, url: 'https://www.inrs.fr/rss/actualites.xml', label: 'INRS', enabled: true, articles: 2, unused: 2 })]);
    await setSourceEnabled(db, editor, workspaceId, id, false, NOW);
    expect((await listSources(db, editor, workspaceId)).sources[0]?.enabled).toBe(false);
    await expect(addSource(db, editor, workspaceId, { url: 'https://www.inrs.fr/rss/actualites.xml', label: 'Doublon' }, NOW)).rejects.toMatchObject({ code: 'source_existante' });
    await deleteSource(db, editor, workspaceId, id, NOW);
    expect((await listSources(db, editor, workspaceId)).sources).toEqual([]);
    await expect(deleteSource(db, editor, workspaceId, id, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('contrôles : adresse, droits, autre client', async () => {
    expect(checkSourceUrl('https://exemple.fr/flux')).toBe('https://exemple.fr/flux');
    expect(() => checkSourceUrl('ftp://exemple.fr/flux')).toThrow('Adresse invalide');
    expect(() => checkSourceUrl('https://moi:secret@exemple.fr/flux')).toThrow('Adresse invalide');
    expect(() => checkSourceUrl('exemple.fr')).toThrow('Adresse invalide');
    await expect(addSource(db, contributor, workspaceId, { url: 'https://exemple.fr/flux', label: 'x' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSources(db, stranger, workspaceId)).rejects.toBeInstanceOf(NotFoundError);
    // Sans libellé : le nom du site.
    const id = await addSource(db, editor, workspaceId, { url: 'https://blog.exemple.fr/feed', label: ' ' }, NOW);
    expect((await listSources(db, editor, workspaceId)).sources.find((s) => s.id === id)?.label).toBe('blog.exemple.fr');
  });
});

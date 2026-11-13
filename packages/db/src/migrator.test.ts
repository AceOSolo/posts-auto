import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, createDatabase } from './client.ts';
import { asUser } from './context.ts';
import { migrateToLatest } from './migrator.ts';
import { createEmptyTempDatabase } from './testing/temp-database.ts';
import { closeTestDatabase, openTestDatabase } from './testing/test-database.ts';

let db: Database;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  db = await openTestDatabase(2);
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await closeTestDatabase(db);
});

describe('migrations', () => {
  it('rejouer les migrations sur une base à jour ne fait rien', async () => {
    expect(await migrateToLatest(db)).toEqual([]);
  });

  it('applique les fichiers dans l’ordre et nomme la migration fautive en cas d’échec', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'posts-auto-migrations-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(path.join(directory, '001_table.sql'), 'CREATE TABLE essai (id int);');
    await writeFile(path.join(directory, '002_erreur.sql'), 'CREATE TABLE essai (id int);'); // table déjà créée
    await writeFile(path.join(directory, 'notes.txt'), 'ignoré : pas une migration');

    const temp = await createEmptyTempDatabase('posts_auto_migrator');
    cleanups.push(() => temp.drop());
    const empty = createDatabase(temp.url, { maxConnections: 1 });
    cleanups.push(() => empty.destroy());

    await expect(migrateToLatest(empty, directory)).rejects.toThrow(/migration 002_erreur.*already exists/);
  });
});

describe('contexte d’exécution', () => {
  it('refuse un identifiant utilisateur qui n’est pas un UUID', async () => {
    await expect(asUser(db, "x'; drop table posts; --", async () => 1)).rejects.toThrow(/identifiant utilisateur invalide/);
  });
});

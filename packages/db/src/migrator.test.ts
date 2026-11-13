import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDatabase } from './client.js';
import { asUser } from './context.js';
import { migrateToLatest } from './migrator.js';
import { createEmptyTempDatabase } from './testing/temp-database.js';

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe('migrations', () => {
  it('rejouer les migrations sur une base à jour ne fait rien', async () => {
    const db = createDatabase(inject('databaseUrl'), { maxConnections: 1 });
    cleanups.push(() => db.destroy());
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
    const db = createDatabase(temp.url, { maxConnections: 1 });
    cleanups.push(() => db.destroy());

    await expect(migrateToLatest(db, directory)).rejects.toThrow(/migration 002_erreur.*already exists/);
  });
});

describe('contexte d’exécution', () => {
  it('refuse un identifiant utilisateur qui n’est pas un UUID', async () => {
    const db = createDatabase(inject('databaseUrl'), { maxConnections: 1 });
    cleanups.push(() => db.destroy());
    await expect(asUser(db, "x'; drop table posts; --", async () => 1)).rejects.toThrow(/identifiant utilisateur invalide/);
  });
});

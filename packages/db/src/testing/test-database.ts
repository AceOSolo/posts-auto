/**
 * Une base propre à chaque fichier de test : copie de la base modèle migrée par la mise en
 * place globale. Les fichiers de test s'exécutent en parallèle sans jamais partager de
 * données (une passe de publication, par exemple, traite tous les posts dus de sa base).
 *
 *   let db: Database;
 *   beforeAll(async () => { db = await openTestDatabase(); });
 *   afterAll(() => closeTestDatabase(db));
 */
import { inject } from 'vitest';
import { type Database, createDatabase } from '../client.ts';
import './provided-context.ts';
import { cloneTempDatabase } from './temp-database.ts';

const drops = new WeakMap<Database, () => Promise<void>>();

export async function openTestDatabase(maxConnections = 6): Promise<Database> {
  const clone = await cloneTempDatabase(inject('databaseUrl'), 'posts_auto_test_file');
  const db = createDatabase(clone.url, { maxConnections });
  drops.set(db, clone.drop);
  return db;
}

export async function closeTestDatabase(db: Database | undefined): Promise<void> {
  if (db === undefined) return;
  await db.destroy();
  await drops.get(db)?.();
}

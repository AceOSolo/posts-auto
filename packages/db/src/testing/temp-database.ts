/**
 * Base jetable : créée vide sur le serveur local, migrée, puis supprimée.
 * Sert aux tests et à la génération des types.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDatabase } from '../client.js';
import { migrateToLatest } from '../migrator.js';

/** Connexion d'administration du serveur local (compose.yaml), sur la base « postgres ». */
export const DEFAULT_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:15432/postgres';

export interface TempDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

async function admin<T>(adminUrl: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `PostgreSQL est injoignable (${new URL(adminUrl).host}). Lancez-le avec : docker compose up -d --wait`,
      { cause: error },
    );
  }
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Base vide (aucune migration appliquée). */
export async function createEmptyTempDatabase(
  prefix: string,
  adminUrl = process.env['TEST_DATABASE_ADMIN_URL'] ?? DEFAULT_ADMIN_URL,
): Promise<TempDatabase> {
  const name = `${prefix}_${Date.now()}_${randomBytes(3).toString('hex')}`;
  await admin(adminUrl, (client) => client.query(`CREATE DATABASE ${name}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => admin(adminUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).then(() => undefined),
  };
}

/** Base à jour de toutes les migrations du dépôt. */
export async function createMigratedTempDatabase(prefix: string, adminUrl?: string): Promise<TempDatabase> {
  const temp = await createEmptyTempDatabase(prefix, adminUrl);
  const db = createDatabase(temp.url, { maxConnections: 2 });
  try {
    await migrateToLatest(db);
  } catch (error) {
    await temp.drop();
    throw error;
  } finally {
    await db.destroy();
  }
  return temp;
}

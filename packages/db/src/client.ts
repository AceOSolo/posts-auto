import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.js';

export type Database = Kysely<DB>;

/** Base de développement locale (compose.yaml). */
export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:15432/posts_auto';

const DATE_OID = 1082;

/**
 * Les colonnes `date` (ex. posts.week_start) restent des chaînes AAAA-MM-JJ :
 * le pilote les convertirait sinon en Date à minuit dans le fuseau de la machine,
 * ce qui décale le jour selon le serveur.
 */
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === DATE_OID ? (value: string) => value : pg.types.getTypeParser(oid, format)) as pg.CustomTypesConfig['getTypeParser'],
};

export interface DatabaseOptions {
  readonly maxConnections?: number;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({ connectionString, max: options.maxConnections ?? 10, types });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.ts';

export type Database = Kysely<DB>;

/** Base de développement locale (compose.yaml). */
export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:15432/posts_auto';

const DATE_OID = 1082;
const DATE_ARRAY_OID = 1182;
const TEXT_ARRAY_OID = 1009;

/**
 * Les colonnes `date` (ex. posts.week_start) restent des chaînes AAAA-MM-JJ :
 * le pilote les convertirait sinon en Date à minuit dans le fuseau de la machine,
 * ce qui décale le jour selon le serveur. Même règle pour les listes de dates
 * (ex. generation_runs.weeks), lues comme des listes de chaînes.
 */
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === DATE_OID) return (value: string) => value;
    if (oid === DATE_ARRAY_OID) return pg.types.getTypeParser(TEXT_ARRAY_OID as Parameters<typeof pg.types.getTypeParser>[0], format);
    return pg.types.getTypeParser(oid, format);
  }) as pg.CustomTypesConfig['getTypeParser'],
};

export interface DatabaseOptions {
  readonly maxConnections?: number;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({ connectionString, max: options.maxConnections ?? 10, types });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Migrations : des fichiers SQL numérotés (migrations/NNN_nom.sql), appliqués dans l'ordre,
 * chacun dans sa propre transaction, une seule fois. Le suivi est tenu par Kysely dans le
 * schéma `migrations`, hors de portée des rôles applicatifs.
 *
 * Une migration appliquée ne se modifie plus : on en ajoute une nouvelle.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Kysely, sql } from 'kysely';
import { type Migration, type MigrationProvider, type MigrationResult, Migrator } from 'kysely/migration';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

class SqlFileMigrationProvider implements MigrationProvider {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.#directory)).filter((file) => FILE_PATTERN.test(file)).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const statements = await readFile(path.join(this.#directory, file), 'utf8');
      migrations[file.replace(/\.sql$/, '')] = {
        // Requête sans paramètre : protocole simple de PostgreSQL, plusieurs instructions permises.
        up: async (db) => {
          await sql.raw(statements).execute(db);
        },
      };
    }
    return migrations;
  }
}

/** Le migrateur ne dépend pas des types de la base : il accepte n'importe quelle instance. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateToLatest(db: Kysely<any>, directory = MIGRATIONS_DIR): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(directory),
    migrationTableSchema: 'migrations',
  });
  const { error, results = [] } = await migrator.migrateToLatest();
  if (error !== undefined) {
    const failed = results.find((result) => result.status === 'Error');
    const where = failed === undefined ? '' : ` (migration ${failed.migrationName})`;
    throw new Error(`Échec des migrations${where} : ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return results;
}

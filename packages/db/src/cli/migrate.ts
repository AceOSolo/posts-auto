/** Applique les migrations en attente : npm run migrate -w @posts-auto/db */
import { DEFAULT_DATABASE_URL, createDatabase } from '../client.js';
import { migrateToLatest } from '../migrator.js';

const url = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
const db = createDatabase(url, { maxConnections: 1 });

try {
  const results = await migrateToLatest(db);
  if (results.length === 0) console.log('Base à jour, aucune migration à appliquer.');
  for (const result of results) console.log(`${result.status === 'Success' ? '✔' : '✘'} ${result.migrationName}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}

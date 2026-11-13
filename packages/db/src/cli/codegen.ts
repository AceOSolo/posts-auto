/**
 * Génère les types TypeScript de la base à partir des migrations :
 *   npm run codegen -w @posts-auto/db            (réécrit src/generated/database.ts)
 *   npm run codegen -w @posts-auto/db -- --verify (échoue si les types ne sont plus à jour)
 *
 * Les migrations SQL sont la source de vérité ; les types en découlent et ne se modifient
 * jamais à la main.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMigratedTempDatabase } from '../testing/temp-database.ts';

const outFile = fileURLToPath(new URL('../generated/database.ts', import.meta.url));
// Réglages (types des statuts, colonnes calculées) : kysely-codegen.json.
const configFile = fileURLToPath(new URL('../../kysely-codegen.json', import.meta.url));
const verify = process.argv.includes('--verify');

const temp = await createMigratedTempDatabase('posts_auto_codegen');
try {
  const result = spawnSync(
    'npx',
    [
      'kysely-codegen',
      '--config-file', configFile,
      '--url', temp.url,
      '--out-file', outFile,
      ...(verify ? ['--verify'] : []),
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await temp.drop();
}

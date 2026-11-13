/**
 * Crée une clé de l'API d'échange pour un espace (en attendant l'écran d'administration) :
 *   npm run api-key -w @posts-auto/web -- --espace <uuid> --nom "Tâche Claude" [--lecture-seule]
 * La clé n'est affichée qu'une fois : seule son empreinte est conservée.
 */
import { parseArgs } from 'node:util';
import { DEFAULT_DATABASE_URL, asSystem, createDatabase } from '@posts-auto/db';
import { createApiKey } from '@posts-auto/services';

const { values } = parseArgs({
  options: { espace: { type: 'string' }, nom: { type: 'string' }, 'lecture-seule': { type: 'boolean', default: false } },
});
if (!values.espace || !values.nom) {
  console.error('Usage : npm run api-key -w @posts-auto/web -- --espace <uuid> --nom "Tâche Claude" [--lecture-seule]');
  process.exit(1);
}

const db = createDatabase(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 1 });
try {
  const workspace = await asSystem(db, (trx) => trx.selectFrom('workspaces').select('name').where('id', '=', values.espace as string).executeTakeFirst());
  if (!workspace) throw new Error(`Espace introuvable : ${values.espace}`);
  const { key } = await createApiKey(db, {
    workspaceId: values.espace,
    name: values.nom,
    scopes: values['lecture-seule'] ? ['posts:read'] : ['posts:read', 'posts:write'],
  });
  console.log(`Clé créée pour l'espace « ${workspace.name} » (${values['lecture-seule'] ? 'lecture seule' : 'lecture et écriture'}) :\n\n  ${key}\n`);
  console.log('Conservez-la dans le coffre de secrets de l’outil qui l’utilise : elle ne sera plus jamais affichée.');
} finally {
  await db.destroy();
}

/**
 * Prépare les tests dans le navigateur : ouvre une session par le vrai parcours de connexion
 * (lien à usage unique) pour chaque personne de la démonstration (npm run seed), et écrit
 * les jetons dans e2e/.sessions.json (fichier local, ignoré par git).
 */
import { writeFileSync } from 'node:fs';
import { DEFAULT_DATABASE_URL, asSystem, createDatabase } from '@posts-auto/db';
import { consumeLoginLink, requestLoginLink } from '@posts-auto/services';

const db = createDatabase(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 1 });
const people = { jp: 'jp@demo.example.test', alexis: 'alexis@demo.example.test', claire: 'claire@demo.example.test' } as const;

try {
  const sessions: Record<string, string> = {};
  for (const [key, email] of Object.entries(people)) {
    // Personnes de démonstration : pas de double authentification à saisir dans ces tests.
    await asSystem(db, (trx) => trx.deleteFrom('user_totp').where('user_id', 'in', trx.selectFrom('users').select('id').where('email', '=', email)).execute());
    const link = await requestLoginLink(db, email, new Date());
    if (link.kind !== 'send') throw new Error(`Pas de lien pour ${email} (${link.kind}) : lancez d'abord npm run seed`);
    const outcome = await consumeLoginLink(db, link.token, new Date(), { userAgent: 'playwright' });
    if (!outcome.ok) throw new Error(`Connexion refusée pour ${email}`);
    sessions[key] = outcome.session.sessionToken;
  }
  const workspace = await asSystem(db, (trx) => trx.selectFrom('workspaces').select('id').where('name', 'like', '%Secutop%').orderBy('created_at').executeTakeFirstOrThrow());
  writeFileSync(new URL('./.sessions.json', import.meta.url), JSON.stringify({ ...sessions, workspaceId: workspace.id }, null, 2));
  console.log('Sessions prêtes pour les tests dans le navigateur.');
} finally {
  await db.destroy();
}

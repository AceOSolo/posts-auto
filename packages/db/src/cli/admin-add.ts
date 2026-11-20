/**
 * Donne l'accès au back-office à une personne de l'éditeur (ADM) :
 * npm run admin:add -w @posts-auto/db -- prenom.nom@simplx.fr
 *
 * La personne doit déjà avoir un compte (inscription ou invitation). Retrait :
 * npm run admin:add -w @posts-auto/db -- --retirer prenom.nom@simplx.fr
 */
import { sql } from 'kysely';
import { DEFAULT_DATABASE_URL, createDatabase } from '../client.ts';

const args = process.argv.slice(2);
const remove = args.includes('--retirer');
const email = args.find((a) => !a.startsWith('--'));
if (!email) {
  console.error('Adresse e-mail attendue.');
  process.exit(1);
}

const db = createDatabase(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 1 });
try {
  const user = await db.selectFrom('users').select('id').where(sql`lower(email)`, '=', email.toLowerCase()).executeTakeFirst();
  if (user === undefined) {
    console.error(`Aucun compte pour ${email}.`);
    process.exitCode = 1;
  } else if (remove) {
    await db.deleteFrom('platform_admins').where('user_id', '=', user.id).execute();
    console.log(`Accès au back-office retiré : ${email}`);
  } else {
    await db.insertInto('platform_admins').values({ user_id: user.id }).onConflict((oc) => oc.column('user_id').doNothing()).execute();
    console.log(`Accès au back-office donné : ${email} (la double authentification lui sera demandée).`);
  }
} finally {
  await db.destroy();
}

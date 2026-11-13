/**
 * Toute requête applicative s'exécute dans une transaction qui fixe QUI agit :
 *
 * - `asUser` : une personne connectée. Rôle `app_web`, soumis à la RLS (migration 006) :
 *   la base ne laisse voir et écrire que les espaces de cette personne.
 * - `asSystem` : une tâche de fond de confiance (publication, replanification, jetons,
 *   liens de validation). Rôle `app_worker`, qui traverse la RLS.
 *
 * `SET LOCAL` et `set_config(…, true)` ne valent que pour la transaction : une connexion
 * rendue au pool ne garde aucun contexte.
 */
import { type Transaction, sql } from 'kysely';
import type { Database } from './client.js';
import type { DB } from './schema.js';

export type Tx = Transaction<DB>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function asUser<T>(db: Database, userId: string, work: (trx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_PATTERN.test(userId)) throw new Error('asUser : identifiant utilisateur invalide');
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.user_id', ${userId}, true)`.execute(trx);
    await sql`set local role app_web`.execute(trx);
    return work(trx);
  });
}

export async function asSystem<T>(db: Database, work: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`set local role app_worker`.execute(trx);
    return work(trx);
  });
}

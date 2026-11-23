/**
 * Suspension décidée par l'éditeur (décision 0008). Distincte des impayés
 * (organizations.status) : seul le back-office la pose et la lève.
 */
import type { Tx } from '@posts-auto/db';
import { sql } from 'kysely';

export async function isOrgSuspended(trx: Tx, orgId: string): Promise<boolean> {
  const row = await trx.selectFrom('org_suspensions').select('org_id').where('org_id', '=', orgId).where('lifted_at', 'is', null).executeTakeFirst();
  return row !== undefined;
}

/** Filtre des tâches de fond : écarte les espaces d'une organisation suspendue. */
export function workspaceNotSuspended(column: string) {
  return sql<boolean>`not exists (select 1 from workspaces sw join org_suspensions ss on ss.org_id = sw.org_id where sw.id = ${sql.ref(column)} and ss.lifted_at is null)`;
}

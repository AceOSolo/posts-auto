/**
 * Consentement à l'apprentissage (LNK-09) : les corrections et les statistiques d'un profil
 * personnel ne servent à la rédaction qu'avec l'accord de son titulaire, retirable. Une page
 * d'entreprise n'est pas une personne : ce consentement ne la concerne pas.
 */
import type { Tx } from '@posts-auto/db';
import { sql } from 'kysely';

/** Condition SQL sur un compte (`alias` de `social_accounts`). */
export function learningConsented(alias: string) {
  return sql<boolean>`(${sql.ref(`${alias}.kind`)} = 'page' or exists (
    select 1 from account_consents learning_consent
    where learning_consent.account_id = ${sql.ref(`${alias}.id`)}
      and learning_consent.user_id = ${sql.ref(`${alias}.holder_user_id`)}
      and learning_consent.kind = 'ai_learning'
      and learning_consent.revoked_at is null
  ))`;
}

/**
 * Préférences utilisables pour rédiger : ce qui a été appris exige le consentement, ce qu'une
 * personne a écrit elle-même sur la fiche du compte reste toujours pris en compte.
 */
export async function usableLearnedSummary(trx: Tx, accountId: string): Promise<string> {
  const row = await trx
    .selectFrom('social_accounts as a')
    .innerJoin('learned_preferences as l', 'l.account_id', 'a.id')
    .select(['l.summary', 'l.edited_by', learningConsented('a').as('allowed')])
    .where('a.id', '=', accountId)
    .executeTakeFirst();
  return row !== undefined && (row.allowed || row.edited_by !== null) ? row.summary : '';
}

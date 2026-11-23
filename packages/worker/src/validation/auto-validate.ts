/**
 * VAL-11 : « Publier sans me demander ». Toutes les minutes, valide les posts des comptes dont
 * le titulaire a donné son accord, tant qu'aucun signal ne demande une relecture humaine.
 *
 * Restent « à valider » :
 * - un texte avec [À COMPLÉTER] ou [À VÉRIFIER] (VAL-03) ;
 * - un post nourri par un contenu extérieur ou une idée déposée (article, demande, e-mail) :
 *   la validation humaine reste le dernier rempart contre l'injection de consignes (M6) ;
 * - une reprise, car le titulaire a demandé à revoir ce post ;
 * - un post déjà touché par une personne (correction, retrait de la validation…) ;
 * - un visuel en préparation, en échec ou illisible ;
 * - un compte en pause, déconnecté, ou un créneau déjà passé (RÈG-06 à RÈG-11).
 */
import { type PostOrigin, applyPostCommand } from '@posts-auto/core';
import { type Database, asSystem } from '@posts-auto/db';
import { sql } from 'kysely';

export const AUTO_VALIDATED_ORIGINS: readonly PostOrigin[] = ['planning', 'event', 'ai_idea'];

export interface AutoValidationDeps {
  readonly db: Database;
  readonly clock?: () => Date;
}

export async function runAutoValidationTick(deps: AutoValidationDeps): Promise<{ validated: string[] }> {
  const now = (deps.clock ?? (() => new Date()))();
  return asSystem(deps.db, async (trx) => {
    const posts = await trx
      .selectFrom('posts as p')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
      .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
      .innerJoin('account_consents as c', (join) =>
        join.onRef('c.account_id', '=', 'a.id').onRef('c.user_id', '=', 'a.holder_user_id').on('c.kind', '=', 'auto_validate').on('c.revoked_at', 'is', null),
      )
      .select(['p.id', 'p.workspace_id', 'w.org_id'])
      .where('p.status', '=', 'a_valider')
      .where('p.scheduled_at', '>', now)
      .where('p.version_no', '=', 1)
      .where('p.origin', 'in', [...AUTO_VALIDATED_ORIGINS])
      .where('a.status', 'in', ['connected', 'expiring'])
      .where('a.publish_mode', '=', 'auto')
      .where('v.has_blocking_markers', '=', false)
      .where(({ exists, not, selectFrom }) => not(exists(selectFrom('post_status_history as h').select('h.id').whereRef('h.post_id', '=', 'p.id').where('h.actor_kind', '=', 'user'))))
      .where(({ exists, not, selectFrom }) => not(exists(selectFrom('post_versions as human').select('human.id').whereRef('human.post_id', '=', 'p.id').where('human.author_kind', '<>', 'ai'))))
      .where(({ exists, not, selectFrom }) => not(exists(selectFrom('visual_tasks as t').select('t.post_id').whereRef('t.post_id', '=', 'p.id'))))
      .where(({ exists, not, selectFrom }) =>
        not(
          exists(
            selectFrom('post_media as pm')
              .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
              .select('pm.id')
              .whereRef('pm.post_id', '=', 'p.id')
              .where(sql<boolean>`coalesce(m.render_content -> 'issues', '[]'::jsonb) <> '[]'::jsonb`),
          ),
        ),
      )
      .forUpdate('p')
      .skipLocked()
      .execute();

    const validated: string[] = [];
    for (const post of posts) {
      const result = applyPostCommand({ status: 'a_valider', hasBlockingMarkers: false }, { type: 'autoValidate' }, { kind: 'system' }, now);
      if (!result.ok) continue;
      await trx.updateTable('posts').set({ status: result.status }).where('id', '=', post.id).execute();
      await trx
        .insertInto('post_status_history')
        .values({ workspace_id: post.workspace_id, post_id: post.id, from_status: 'a_valider', to_status: result.status, actor_kind: 'system', reason: result.change.reason, at: now })
        .execute();
      await trx
        .insertInto('audit_log')
        .values({ org_id: post.org_id, workspace_id: post.workspace_id, actor_kind: 'system', action: 'post.validation_automatique', entity: 'post', entity_id: post.id, at: now })
        .execute();
      validated.push(post.id);
    }
    return { validated };
  });
}

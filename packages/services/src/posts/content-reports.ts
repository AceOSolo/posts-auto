/**
 * « Signaler un contenu » (GEN-12), sur chaque post : toute personne qui voit le post peut
 * signaler un texte ou un visuel problématique. L'éditeur du produit (SimplX) traite le
 * signalement dans le délai affiché.
 */
import { type Database, asUser } from '@posts-auto/db';
import { cleanText } from '../audit.ts';
import { NotFoundError, RefusedError } from '../errors.ts';

/** Délai de traitement affiché à la personne qui signale (GEN-12). */
export const CONTENT_REPORT_DELAY = '2 jours ouvrés';

export interface ContentReportReceipt {
  readonly reportId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly accountName: string;
  readonly reporterEmail: string;
}

export async function reportContent(db: Database, userId: string, postId: string, reason: string, now: Date): Promise<ContentReportReceipt> {
  const text = cleanText(reason, 2000);
  if (text === null) throw new RefusedError('motif_signalement_requis', 'Dites ce qui pose problème.');
  return asUser(db, userId, async (trx) => {
    const post = await trx
      .selectFrom('posts as p')
      .innerJoin('workspaces as w', 'w.id', 'p.workspace_id')
      .innerJoin('social_accounts as a', 'a.id', 'p.account_id')
      .select(['p.workspace_id', 'w.name', 'a.display_name'])
      .where('p.id', '=', postId)
      .executeTakeFirst();
    if (post === undefined) throw new NotFoundError('Post');
    const reporter = await trx.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow();
    const row = await trx
      .insertInto('content_reports')
      .values({ workspace_id: post.workspace_id, post_id: postId, reported_by: userId, reason: text, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { reportId: row.id, workspaceId: post.workspace_id, workspaceName: post.name, accountName: post.display_name ?? 'Compte', reporterEmail: reporter.email };
  });
}

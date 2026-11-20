/**
 * Envoi des notifications par e-mail (section 5.12), toutes les minutes.
 *
 * - Préférences de chacun respectées (NOT-01) : une notification refusée est « écartée ».
 * - Échec passager (Brevo injoignable, limite) : nouvel essai au passage suivant, 5 essais
 *   au plus ; échec définitif (adresse refusée) : « en échec ».
 * - Une notification de plus de 3 jours n'est plus envoyée (un rappel périmé égare plus
 *   qu'il n'aide) : elle est écartée.
 * - Une ligne n'est traitée que par un processus à la fois (verrou de ligne).
 */
import { type Database, asSystem } from '@posts-auto/db';
import { MailError, type MailMessage, type Mailer, createApprovalLink, notificationMail } from '@posts-auto/services';
import type { MediaStore } from '../media/media-store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const STALE_AFTER_DAYS = 3;
const BATCH = 100;

export interface EmailDispatchDeps {
  readonly db: Database;
  readonly mailer: Mailer;
  readonly appUrl: string;
  /** PUB-09 : images jointes aux posts à publier à la main. */
  readonly media?: MediaStore;
  readonly clock?: () => Date;
}

export interface EmailDispatchReport {
  readonly sent: string[];
  readonly skipped: string[];
  readonly retrying: string[];
  readonly failed: string[];
  readonly stale: number;
}

export async function runEmailDispatch(deps: EmailDispatchDeps): Promise<EmailDispatchReport> {
  const now = (deps.clock ?? (() => new Date()))();
  const staleBefore = new Date(now.getTime() - STALE_AFTER_DAYS * 86_400_000);

  const stale = await asSystem(deps.db, (trx) =>
    trx
      .updateTable('notifications')
      .set({ delivery_status: 'skipped', last_error: 'Périmée : non envoyée' })
      .where('channel', '=', 'email')
      .where('delivery_status', 'is', null)
      .where('created_at', '<', staleBefore)
      .executeTakeFirst(),
  );
  const report: EmailDispatchReport = { sent: [], skipped: [], retrying: [], failed: [], stale: Number(stale.numUpdatedRows) };

  const done: string[] = [];
  for (let i = 0; i < BATCH; i += 1) {
    const processed = await asSystem(deps.db, async (trx) => {
      let query = trx
        .selectFrom('notifications as n')
        .innerJoin('users as u', 'u.id', 'n.user_id')
        .leftJoin('workspaces as w', 'w.id', 'n.workspace_id')
        .select(['n.id', 'n.user_id', 'n.kind', 'n.payload', 'n.delivery_attempts', 'n.workspace_id', 'u.email', 'u.full_name', 'w.timezone'])
        .where('n.channel', '=', 'email')
        .where('n.delivery_status', 'is', null)
        .orderBy('n.created_at')
        .limit(1)
        .forUpdate('n')
        .skipLocked();
      // Chaque ligne n'est essayée qu'une fois par passage : les nouveaux essais attendent le suivant.
      if (done.length > 0) query = query.where('n.id', 'not in', done);
      const row = await query.executeTakeFirst();
      if (row === undefined) return false;
      done.push(row.id);

      const pref = await trx
        .selectFrom('notification_prefs')
        .select('email')
        .where('user_id', '=', row.user_id)
        .where('kind', '=', row.kind)
        .executeTakeFirst();
      // L'espace de la notification sert aux liens (ex. page des comptes pour reconnecter, REC-09).
      const payload: Record<string, unknown> = { ...((row.payload ?? {}) as Record<string, unknown>), ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}) };
      // VAL-06 : lien « Valider maintenant » créé à l'envoi (le jeton n'existe en clair que dans l'e-mail),
      // seulement si le post attend encore une décision.
      if (row.kind === 'rappel_validation' && pref?.email !== false && typeof payload['postId'] === 'string' && UUID.test(payload['postId'])) {
        const post = await trx.selectFrom('posts').select('status').where('id', '=', payload['postId']).executeTakeFirst();
        if (post?.status === 'a_valider') {
          const token = await createApprovalLink(deps.db, payload['postId'], row.user_id, now);
          payload['approvalUrl'] = `${deps.appUrl}/valider/${token}`;
        }
      }
      const mail =
        pref?.email === false ? null : notificationMail(row.kind, payload, { appUrl: deps.appUrl, recipientName: row.full_name, timeZone: row.timezone ?? 'Europe/Paris' });
      if (mail === null) {
        await trx.updateTable('notifications').set({ delivery_status: 'skipped' }).where('id', '=', row.id).execute();
        report.skipped.push(row.id);
        return true;
      }

      let attachments: MailMessage['attachments'] = [];
      if (row.kind === 'publication_manuelle' && deps.media !== undefined && typeof payload['postId'] === 'string' && UUID.test(payload['postId'])) {
        const files = await trx
          .selectFrom('post_media as pm')
          .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
          .select(['m.storage_key', 'm.mime'])
          .where('pm.post_id', '=', payload['postId'])
          .orderBy('pm.position')
          .execute();
        const media = deps.media;
        const read = await Promise.all(
          files.map(async (f, i) => {
            const content = await media.read(f.storage_key).catch(() => null);
            const ext = f.mime === 'image/png' ? 'png' : f.mime === 'image/webp' ? 'webp' : f.mime === 'image/gif' ? 'gif' : 'jpg';
            return content === null ? null : { name: `image-${i + 1}.${ext}`, content };
          }),
        );
        // Une image illisible n'empêche pas l'envoi du texte ; le lien du post permet de la récupérer.
        attachments = read.filter((a) => a !== null);
      }

      try {
        await deps.mailer.send({ to: { email: row.email, name: row.full_name }, ...mail, tag: row.kind, ...(attachments.length > 0 && { attachments }) });
        await trx.updateTable('notifications').set({ delivery_status: 'sent', sent_at: now, delivery_attempts: row.delivery_attempts + 1 }).where('id', '=', row.id).execute();
        report.sent.push(row.id);
      } catch (error) {
        const attempts = row.delivery_attempts + 1;
        const retry = error instanceof MailError && error.retryable && attempts < MAX_DELIVERY_ATTEMPTS;
        await trx
          .updateTable('notifications')
          .set({ delivery_attempts: attempts, last_error: error instanceof Error ? error.message : String(error), delivery_status: retry ? null : 'failed' })
          .where('id', '=', row.id)
          .execute();
        (retry ? report.retrying : report.failed).push(row.id);
      }
      return true;
    });
    if (!processed) break;
  }
  return report;
}

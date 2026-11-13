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
import { MailError, type Mailer, notificationMail } from '@posts-auto/services';

export const MAX_DELIVERY_ATTEMPTS = 5;
export const STALE_AFTER_DAYS = 3;
const BATCH = 100;

export interface EmailDispatchDeps {
  readonly db: Database;
  readonly mailer: Mailer;
  readonly appUrl: string;
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
      const payload = { ...((row.payload ?? {}) as Record<string, unknown>), ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}) };
      const mail =
        pref?.email === false ? null : notificationMail(row.kind, payload, { appUrl: deps.appUrl, recipientName: row.full_name, timeZone: row.timezone ?? 'Europe/Paris' });
      if (mail === null) {
        await trx.updateTable('notifications').set({ delivery_status: 'skipped' }).where('id', '=', row.id).execute();
        report.skipped.push(row.id);
        return true;
      }

      try {
        await deps.mailer.send({ to: { email: row.email, name: row.full_name }, ...mail, tag: row.kind });
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

/**
 * Centre de notifications de la personne (section 5.12, NOT-01) : notifications dans
 * l'application, et réglage par type des e-mails reçus. Chacun ne voit et ne règle que les
 * siennes (RLS).
 */
import { type Database, asUser } from '@posts-auto/db';
import { RefusedError } from '../errors.ts';

/** Types de notification, dans l'ordre d'affichage des réglages. */
export const NOTIFICATION_KINDS = {
  rappel_validation: 'Rappel avant le créneau d’un post à valider (24 h et 3 h avant)',
  recap_hebdo: 'Récapitulatif du lundi matin',
  post_replanifie: 'Post replanifié faute de validation',
  post_abandonne: 'Post sorti du circuit',
  publication_erreur: 'Erreur de publication',
  post_publie: 'Post publié',
  connexion_expire_bientot: 'Connexion LinkedIn qui expire bientôt',
  connexion_expiree: 'Connexion LinkedIn expirée',
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export interface InAppNotification {
  readonly id: string;
  readonly title: string;
  readonly href: string | null;
  readonly createdAt: Date;
  readonly read: boolean;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Texte et lien d'une notification dans l'application. */
export function describeNotification(kind: string, payload: Record<string, unknown>): { title: string; href: string | null } {
  const post = str(payload['postId']) ? `/posts/${encodeURIComponent(str(payload['postId']))}` : null;
  const account = str(payload['accountName']) || 'un compte LinkedIn';
  switch (kind) {
    case 'rappel_validation':
      return { title: `Un post de ${account} attend votre validation (départ dans ${String(payload['hours'])} h)`, href: post };
    case 'recap_hebdo':
      return { title: `${String(payload['count'])} post(s) à valider cette semaine`, href: '/' };
    case 'post_replanifie':
      return { title: payload['movedToAnotherWeek'] === true ? 'Un post a été replanifié la semaine prochaine faute de validation' : 'Un post a été replanifié faute de validation', href: post };
    case 'post_abandonne':
      return { title: 'Un post est sorti du circuit', href: post };
    case 'publication_erreur':
      return { title: payload['uncertain'] === true ? 'Publication incertaine : vérification nécessaire' : 'Un post n’a pas pu être publié', href: post };
    case 'post_publie':
      return { title: 'Votre post a été publié sur LinkedIn', href: post };
    case 'connexion_expire_bientot':
      return { title: `La connexion LinkedIn de ${account} expire dans ${String(payload['daysLeft'])} jour(s)`, href: null };
    case 'connexion_expiree':
      return { title: `La connexion LinkedIn de ${account} a expiré`, href: null };
    default:
      return { title: 'Notification', href: null };
  }
}

export async function listNotifications(db: Database, userId: string, limit = 50): Promise<{ items: InAppNotification[]; unread: number }> {
  return asUser(db, userId, async (trx) => {
    const rows = await trx
      .selectFrom('notifications')
      .select(['id', 'kind', 'payload', 'created_at', 'read_at'])
      .where('user_id', '=', userId)
      .where('channel', '=', 'in_app')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    const unread = await trx
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where('channel', '=', 'in_app')
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return {
      unread: Number(unread.n),
      items: rows.map((row) => ({
        id: row.id,
        ...describeNotification(row.kind, (row.payload ?? {}) as Record<string, unknown>),
        createdAt: row.created_at,
        read: row.read_at !== null,
      })),
    };
  });
}

export async function markAllNotificationsRead(db: Database, userId: string, now: Date): Promise<void> {
  await asUser(db, userId, (trx) =>
    trx.updateTable('notifications').set({ read_at: now }).where('user_id', '=', userId).where('channel', '=', 'in_app').where('read_at', 'is', null).execute(),
  );
}

export interface NotificationPreference {
  readonly kind: NotificationKind;
  readonly label: string;
  readonly email: boolean;
}

/** Réglages par type ; sans réglage enregistré, l'e-mail est activé. */
export async function getNotificationPreferences(db: Database, userId: string): Promise<NotificationPreference[]> {
  const rows = await asUser(db, userId, (trx) => trx.selectFrom('notification_prefs').select(['kind', 'email']).where('user_id', '=', userId).execute());
  return (Object.entries(NOTIFICATION_KINDS) as [NotificationKind, string][]).map(([kind, label]) => ({
    kind,
    label,
    email: rows.find((row) => row.kind === kind)?.email ?? true,
  }));
}

/** Enregistre les e-mails voulus : les types absents de la liste sont désactivés. */
export async function setEmailPreferences(db: Database, userId: string, enabledKinds: readonly string[]): Promise<void> {
  const unknown = enabledKinds.filter((kind) => !(kind in NOTIFICATION_KINDS));
  if (unknown.length > 0) throw new RefusedError('type_inconnu', 'Type de notification inconnu.');
  await asUser(db, userId, async (trx) => {
    for (const kind of Object.keys(NOTIFICATION_KINDS)) {
      const email = enabledKinds.includes(kind);
      await trx
        .insertInto('notification_prefs')
        .values({ user_id: userId, kind, email })
        .onConflict((oc) => oc.columns(['user_id', 'kind']).doUpdateSet({ email }))
        .execute();
    }
  });
}

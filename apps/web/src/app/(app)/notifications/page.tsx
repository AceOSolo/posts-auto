import { getNotificationPreferences, listNotifications, markAllNotificationsRead, setEmailPreferences } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Flash } from '../../../components/flash.tsx';
import { database } from '../../../server/context.ts';
import { requireUserId } from '../../../server/session.ts';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

async function markAllRead(): Promise<void> {
  'use server';
  const userId = await requireUserId();
  await markAllNotificationsRead(database(), userId, new Date());
  redirect('/notifications');
}

async function savePreferences(formData: FormData): Promise<void> {
  'use server';
  const userId = await requireUserId();
  await setEmailPreferences(database(), userId, formData.getAll('email').map(String));
  redirect('/notifications?message=preferences-enregistrees');
}

/** Notifications dans l'application et réglage des e-mails (NOT-01). */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const userId = await requireUserId();
  const { message } = await searchParams;
  const { items, unread } = await listNotifications(database(), userId);
  const preferences = await getNotificationPreferences(database(), userId);
  const format = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' });

  return (
    <>
      <h1>Notifications</h1>
      <Flash code={message} />
      {unread > 0 && (
        <form action={markAllRead}>
          <button type="submit">Tout marquer comme lu ({unread})</button>
        </form>
      )}
      {items.length === 0 ? (
        <p className="muted">Aucune notification.</p>
      ) : (
        <ul className="notification-list">
          {items.map((item) => (
            <li key={item.id} className={item.read ? 'read' : 'unread'}>
              <time dateTime={item.createdAt.toISOString()}>{format.format(item.createdAt)}</time>
              {item.href ? <Link href={item.href}>{item.title}</Link> : <span>{item.title}</span>}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="reglages">
        <h2 id="reglages">E-mails que je reçois</h2>
        <form action={savePreferences} className="stack">
          {preferences.map((preference) => (
            <label key={preference.kind} className="check">
              <input type="checkbox" name="email" value={preference.kind} defaultChecked={preference.email} /> {preference.label}
            </label>
          ))}
          <p className="hint">Les notifications restent visibles ici même quand l’e-mail est désactivé.</p>
          <button type="submit">Enregistrer mes réglages</button>
        </form>
      </section>
    </>
  );
}

import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeNotification, getNotificationPreferences, listNotifications, markAllNotificationsRead, setEmailPreferences } from './notification-center.ts';

let db: Database;
let me: string;
let someoneElse: string;
let workspaceId: string;
const NOW = new Date('2026-11-16T09:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  me = await createUser(db, 'moi');
  someoneElse = await createUser(db, 'autre');
  await addMember(db, workspaceId, me, 'contributor');
  await addMember(db, workspaceId, someoneElse, 'contributor');
  await asSystem(db, (trx) =>
    trx
      .insertInto('notifications')
      .values([
        { user_id: me, workspace_id: workspaceId, kind: 'rappel_validation', channel: 'in_app', payload: JSON.stringify({ postId: 'p1', accountName: 'JP', hours: 3 }) },
        { user_id: me, workspace_id: workspaceId, kind: 'rappel_validation', channel: 'email', payload: JSON.stringify({ postId: 'p1', hours: 3 }) },
        { user_id: me, workspace_id: workspaceId, kind: 'post_publie', channel: 'in_app', payload: JSON.stringify({ postId: 'p2' }) },
        { user_id: someoneElse, workspace_id: workspaceId, kind: 'post_publie', channel: 'in_app', payload: JSON.stringify({ postId: 'p3' }) },
      ])
      .execute(),
  );
});
afterAll(() => closeTestDatabase(db));

describe('notifications dans l’application', () => {
  it('liste les siennes seulement, dans l’application, avec un texte et un lien', async () => {
    const { items, unread } = await listNotifications(db, me);
    expect(unread).toBe(2);
    expect(items.map((n) => n.title).sort()).toEqual(['Un post de JP attend votre validation (départ dans 3 h)', 'Votre post a été publié sur LinkedIn'].sort());
    expect(items.find((n) => n.title.startsWith('Un post de JP'))?.href).toBe('/posts/p1');
  });

  it('« tout marquer comme lu » ne touche que les siennes', async () => {
    await markAllNotificationsRead(db, me, NOW);
    expect((await listNotifications(db, me)).unread).toBe(0);
    expect((await listNotifications(db, someoneElse)).unread).toBe(1);
  });

  it('décrit chaque type connu', () => {
    expect(describeNotification('connexion_expiree', { accountName: 'Page Secutop' }).title).toBe('La connexion LinkedIn de Page Secutop a expiré');
    expect(describeNotification('inconnu', {}).title).toBe('Notification');
  });
});

describe('réglages des e-mails (NOT-01)', () => {
  it('tout est activé par défaut ; désactiver un type est enregistré', async () => {
    expect((await getNotificationPreferences(db, me)).every((p) => p.email)).toBe(true);
    await setEmailPreferences(db, me, ['publication_erreur', 'connexion_expiree']);
    const prefs = await getNotificationPreferences(db, me);
    expect(prefs.filter((p) => p.email).map((p) => p.kind).sort()).toEqual(['connexion_expiree', 'publication_erreur']);
    expect((await getNotificationPreferences(db, someoneElse)).every((p) => p.email)).toBe(true);
  });

  it('refuse un type inconnu', async () => {
    await expect(setEmailPreferences(db, me, ['nimporte_quoi'])).rejects.toMatchObject({ code: 'type_inconnu' });
  });
});

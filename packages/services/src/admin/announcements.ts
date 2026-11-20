/** ADM-06 : annonces dans l'application (nouveautés, maintenance), affichées à tous. */
import { type Database, asSystem } from '@posts-auto/db';
import { RefusedError } from '../errors.ts';
import { requirePlatformAdmin } from './platform.ts';

export interface Announcement {
  readonly id: string;
  readonly message: string;
  readonly level: 'info' | 'maintenance';
  readonly startsAt: Date;
  readonly endsAt: Date;
}

const toAnnouncement = (r: { id: string; message: string; level: string; starts_at: Date; ends_at: Date }): Announcement => ({
  id: r.id,
  message: r.message,
  level: r.level as 'info' | 'maintenance',
  startsAt: r.starts_at,
  endsAt: r.ends_at,
});

/** Annonces en cours, pour le bandeau de l'application. */
export async function activeAnnouncements(db: Database, now: Date): Promise<Announcement[]> {
  const rows = await asSystem(db, (trx) => trx.selectFrom('announcements').selectAll().where('starts_at', '<=', now).where('ends_at', '>', now).orderBy('starts_at', 'desc').limit(3).execute());
  return rows.map(toAnnouncement);
}

export async function listAnnouncements(db: Database, adminId: string, now: Date): Promise<Announcement[]> {
  await requirePlatformAdmin(db, adminId);
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await asSystem(db, (trx) => trx.selectFrom('announcements').selectAll().where('ends_at', '>', since).orderBy('starts_at', 'desc').execute());
  return rows.map(toAnnouncement);
}

export async function createAnnouncement(
  db: Database,
  adminId: string,
  input: { readonly message: string; readonly level: string; readonly startsAt: Date | null; readonly endsAt: Date | null },
  now: Date,
): Promise<string> {
  await requirePlatformAdmin(db, adminId);
  const message = input.message.trim().replace(/\s+/g, ' ');
  if (message.length === 0 || message.length > 500) throw new RefusedError('annonce_invalide', 'Le message doit faire entre 1 et 500 caractères.');
  const level = input.level === 'maintenance' ? 'maintenance' : 'info';
  const startsAt = input.startsAt ?? now;
  const endsAt = input.endsAt ?? new Date(startsAt.getTime() + 7 * 86_400_000);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= startsAt.getTime()) throw new RefusedError('dates_invalides', 'La fin doit être après le début.');
  const row = await asSystem(db, (trx) =>
    trx.insertInto('announcements').values({ message, level, starts_at: startsAt, ends_at: endsAt, created_by: adminId, created_at: now }).returning('id').executeTakeFirstOrThrow(),
  );
  return row.id;
}

/** Retire une annonce tout de suite (fin à maintenant). */
export async function endAnnouncement(db: Database, adminId: string, id: string, now: Date): Promise<void> {
  await requirePlatformAdmin(db, adminId);
  await asSystem(db, (trx) =>
    trx
      .updateTable('announcements')
      .set((eb) => ({ ends_at: now, starts_at: eb.fn('least', [eb.ref('starts_at'), eb.val(new Date(now.getTime() - 1000))]) }))
      .where('id', '=', id)
      .where('ends_at', '>', now)
      .execute(),
  );
}

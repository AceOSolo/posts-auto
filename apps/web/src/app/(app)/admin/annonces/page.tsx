import { listAnnouncements } from '@posts-auto/services';
import type { Metadata } from 'next';
import { Flash } from '../../../../components/flash.tsx';
import { requireAdmin } from '../../../../server/admin.ts';
import { database } from '../../../../server/context.ts';
import { createAnnouncementAction, endAnnouncementAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Annonces' };
export const dynamic = 'force-dynamic';

const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** ADM-06 : annonces affichées en bandeau à tous les utilisateurs. */
export default async function AnnouncementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const adminId = await requireAdmin();
  const { message } = await searchParams;
  const now = new Date();
  const items = await listAnnouncements(database(), adminId, now);
  return (
    <>
      <h1>Annonces</h1>
      <Flash code={message} />
      <form action={createAnnouncementAction} className="stack">
        <label>
          Message (500 caractères au plus)
          <textarea name="message" rows={3} maxLength={500} required />
        </label>
        <fieldset>
          <legend>Type</legend>
          <label>
            <input type="radio" name="niveau" value="info" defaultChecked /> nouveauté ou information
          </label>
          <label>
            <input type="radio" name="niveau" value="maintenance" /> maintenance
          </label>
        </fieldset>
        <div className="inline-fields">
          <label>
            Début (heure de Paris ; vide : maintenant)
            <input type="datetime-local" name="debut" />
          </label>
          <label>
            Fin (vide : dans 7 jours)
            <input type="datetime-local" name="fin" />
          </label>
        </div>
        <button type="submit">Publier l’annonce</button>
      </form>

      <h2>Annonces récentes</h2>
      {items.length === 0 ? (
        <p className="muted">Aucune annonce.</p>
      ) : (
        <ul>
          {items.map((a) => {
            const live = a.startsAt <= now && a.endsAt > now;
            return (
              <li key={a.id}>
                <strong>{a.level === 'maintenance' ? 'Maintenance' : 'Information'}</strong> · du {date.format(a.startsAt)} au {date.format(a.endsAt)}
                {live ? ' · en ligne' : a.startsAt > now ? ' · programmée' : ' · terminée'}
                <br />
                {a.message}
                {a.endsAt > now && (
                  <form action={endAnnouncementAction.bind(null, a.id)} className="inline-fields">
                    <button type="submit">Retirer</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

import { NotFoundError, type PlannedEvent, listEvents, listWorkspaceAccounts, planningGrid } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { StatusBadge } from '../../../../../components/status-badge.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { deleteEventAction, saveEventAction } from '../../actions.ts';
import { PlanningNav } from '../../planning-ui.tsx';

export const metadata: Metadata = { title: 'Événements à relayer' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPEATS: Record<string, string> = { weekly: 'Chaque semaine', monthly: 'Chaque mois', yearly: 'Chaque année' };
const longDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const day = (date: string) => longDate.format(new Date(`${date}T00:00:00Z`));

function EventFields({ event, accounts }: { event?: PlannedEvent; accounts: readonly { id: string; name: string }[] }) {
  const p = event?.id ?? 'nouveau';
  return (
    <>
      <label htmlFor={`titre-${p}`}>Titre</label>
      <input id={`titre-${p}`} name="titre" required maxLength={300} defaultValue={event?.title ?? ''} />
      <label htmlFor={`debut-${p}`}>Début</label>
      <input id={`debut-${p}`} name="debut" type="date" required defaultValue={event?.startsOn ?? ''} />
      <label htmlFor={`fin-${p}`}>Fin (facultatif)</label>
      <input id={`fin-${p}`} name="fin" type="date" defaultValue={event?.endsOn ?? ''} />
      <label htmlFor={`lien-${p}`}>Lien</label>
      <input id={`lien-${p}`} name="lien" type="url" maxLength={1000} defaultValue={event?.link ?? ''} />
      {!event?.seriesId && (
        <div className="inline-fields">
          <div>
            <label htmlFor={`recurrence-${p}`}>Se répète</label>
            <select id={`recurrence-${p}`} name="recurrence" defaultValue={event?.recurrence ?? 'none'}>
              <option value="none">Jamais</option>
              <option value="weekly">Chaque semaine</option>
              <option value="monthly">Chaque mois</option>
              <option value="yearly">Chaque année</option>
            </select>
          </div>
          <div>
            <label htmlFor={`jusqua-${p}`}>Jusqu’au (facultatif)</label>
            <input id={`jusqua-${p}`} name="jusqua" type="date" defaultValue={event?.recurrenceUntil ?? ''} />
          </div>
        </div>
      )}
      <label htmlFor={`details-${p}`}>Détails utiles à la rédaction</label>
      <textarea id={`details-${p}`} name="details" rows={3} maxLength={4000} defaultValue={event?.details ?? ''} />
      <fieldset>
        <legend>Comptes qui relaient</legend>
        {accounts.map((a) => (
          <label key={a.id} className="check">
            <input type="checkbox" name="comptes" value={a.id} defaultChecked={event?.accountIds.includes(a.id) ?? false} /> {a.name}
          </label>
        ))}
      </fieldset>
    </>
  );
}

/** PLA-04 : événements datés, relayés automatiquement sur les comptes choisis dans les 3 semaines qui précèdent. */
export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let data;
  try {
    const { currentWeek } = await planningGrid(database(), userId, workspaceId, { weeks: 1 }, new Date());
    data = await Promise.all([listEvents(database(), userId, workspaceId, currentWeek), listWorkspaceAccounts(database(), userId, workspaceId)]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [{ events, canEdit }, accountList] = data;
  const accounts = accountList.map((a) => ({ id: a.id, name: a.name }));
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));

  return (
    <>
      <h1>Événements à relayer</h1>
      <PlanningNav workspaceId={workspaceId} current="evenements" />
      <Flash code={message} />
      <p className="hint">
        Chaque compte choisi publie un post sur l’événement dans les 3 semaines qui le précèdent, jamais après sa date. Un rendez-vous qui se répète
        (webinaire mensuel, salon annuel, journée mondiale) est relayé à chaque occurrence.
      </p>

      {events.length === 0 && <p className="muted">Aucun événement à venir.</p>}
      <ul className="cards">
        {events.map((event) => (
          <li key={event.id} className="card">
            <h2>
              {event.title} {event.recurrence !== 'none' && <span className="badge">{REPEATS[event.recurrence]}</span>}
              {event.seriesId && <span className="badge">Rendez-vous récurrent</span>}
            </h2>
            <p>
              {day(event.startsOn)}
              {event.endsOn && event.endsOn !== event.startsOn && ` au ${day(event.endsOn)}`}
            </p>
            {event.link && (
              <p>
                <a href={event.link} rel="noopener noreferrer" target="_blank">
                  {event.link}
                </a>
              </p>
            )}
            <ul className="plain">
              {event.accountIds.map((id) => {
                const relay = event.relays.find((r) => r.accountId === id);
                return (
                  <li key={id}>
                    {nameOf.get(id) ?? 'Compte'} :{' '}
                    {relay ? (
                      <>
                        <Link href={`/posts/${relay.postId}`}>post</Link> <StatusBadge status={relay.status} />
                      </>
                    ) : (
                      <span className="muted">relais pas encore rédigé</span>
                    )}
                  </li>
                );
              })}
              {event.accountIds.length === 0 && <li className="muted">Aucun compte ne relaie cet événement.</li>}
            </ul>
            {canEdit && (
              <div className="stack">
                <details>
                  <summary>Modifier</summary>
                  <form action={saveEventAction.bind(null, workspaceId, event.id)} className="stack">
                    <EventFields event={event} accounts={accounts} />
                    <button type="submit">Enregistrer</button>
                  </form>
                </details>
                <form action={deleteEventAction.bind(null, workspaceId, event.id)}>
                  <button type="submit">Supprimer l’événement</button>
                </form>
              </div>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <details open={events.length === 0}>
          <summary>Ajouter un événement</summary>
          <form action={saveEventAction.bind(null, workspaceId, null)} className="stack">
            <EventFields accounts={accounts} />
            <button type="submit" className="primary">
              Ajouter
            </button>
          </form>
        </details>
      )}
    </>
  );
}

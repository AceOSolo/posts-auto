import { NotFoundError, type RequestStatus, listPostRequests, listWorkspaceAccounts } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { StatusBadge } from '../../../../components/status-badge.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { createRequestAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Demandes de post' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<RequestStatus, string> = {
  new: 'Reçue : rédaction dans l’heure',
  in_progress: 'En cours de rédaction',
  done: 'Traitée',
  impossible: 'Impossible à traiter',
};
const dateTime = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

/** IDE-03, IDE-06 : demande d'un post précis, et suivi par le demandeur. */
export default async function RequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message, toutes } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const all = toutes === '1';
  let data;
  try {
    data = await Promise.all([listPostRequests(database(), userId, workspaceId, { mine: !all }), listWorkspaceAccounts(database(), userId, workspaceId)]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [{ requests, canPropose }, accountList] = data;
  const nameOf = new Map(accountList.map((a) => [a.id, a.name]));

  return (
    <>
      <h1>Demandes de post</h1>
      <nav aria-label="Demandes" className="subnav">
        <Link href={`/demandes/${workspaceId}`} aria-current={all ? undefined : 'page'}>
          Mes demandes
        </Link>
        <Link href={`/demandes/${workspaceId}?toutes=1`} aria-current={all ? 'page' : undefined}>
          Toutes les demandes
        </Link>
        <Link href={`/idees/${workspaceId}`}>Idées</Link>
      </nav>
      <Flash code={message} />

      {canPropose && (
        <section aria-labelledby="nouvelle">
          <h2 id="nouvelle">Nouvelle demande</h2>
          <p className="hint">Un post précis, sur un ou plusieurs comptes, à une date donnée. Il est rédigé dans l’heure puis soumis à validation.</p>
          <form action={createRequestAction.bind(null, workspaceId)} className="stack">
            <label htmlFor="demande">Ce que vous voulez dire</label>
            <textarea id="demande" name="demande" rows={5} required maxLength={5000} aria-describedby="demande-aide" />
            <p id="demande-aide" className="hint">
              Les faits, les chiffres, les noms : l’IA n’invente rien et marquera [À COMPLÉTER] ce qui manque.
            </p>
            <fieldset>
              <legend>Comptes</legend>
              {accountList.map((a) => (
                <label key={a.id} className="check">
                  <input type="checkbox" name="comptes" value={a.id} /> {a.name}
                </label>
              ))}
            </fieldset>
            <div className="inline-fields">
              <div>
                <label htmlFor="date">Date souhaitée</label>
                <input id="date" name="date" type="date" />
              </div>
              <div>
                <label htmlFor="heure">Heure</label>
                <input id="heure" name="heure" type="time" step={300} />
              </div>
            </div>
            <p className="hint">Sans date, le post prend le prochain créneau libre. Si le créneau souhaité est pris, il prend le plus proche après.</p>
            <label htmlFor="liens">Liens (un par ligne)</label>
            <textarea id="liens" name="liens" rows={2} />
            <label htmlFor="photos">Photos (9 au plus ; la première est le visuel principal)</label>
            <input id="photos" name="photos" type="file" accept="image/jpeg,image/png,image/gif" multiple />
            <button type="submit" className="primary">
              Envoyer la demande
            </button>
          </form>
        </section>
      )}

      <section aria-labelledby="suivi">
        <h2 id="suivi">{all ? 'Toutes les demandes' : 'Mes demandes'}</h2>
        {requests.length === 0 && <p className="muted">Aucune demande.</p>}
        <ul className="cards">
          {requests.map((request) => (
            <li key={request.id} className="card">
              <p>
                <span className={`badge ${request.status === 'done' ? 'status-publie' : request.status === 'impossible' ? 'status-erreur' : 'status-a_valider'}`}>
                  {STATUS[request.status]}
                </span>
              </p>
              <p className="pre">{request.rawText ?? request.details}</p>
              <p className="muted">
                {request.accountIds.map((id) => nameOf.get(id) ?? 'Compte').join(', ')}
                {request.wishedAt && ` · souhaité le ${dateTime.format(request.wishedAt)}`}
                {request.photoCount > 0 && ` · ${request.photoCount} photo${request.photoCount > 1 ? 's' : ''}`}
                {all && request.authorName && ` · demandée par ${request.authorName}`}
              </p>
              {request.followup && <p className="ai-note">Suivi : {request.followup}</p>}
              {request.posts.map((post) => (
                <p key={post.id}>
                  <Link href={`/posts/${post.id}`}>
                    Post de {nameOf.get(post.accountId) ?? 'compte'}, {dateTime.format(post.scheduledAt)}
                  </Link>{' '}
                  <StatusBadge status={post.status} />
                </p>
              ))}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

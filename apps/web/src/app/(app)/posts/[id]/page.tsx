import { REFUSAL_REASONS } from '@posts-auto/core';
import { NotFoundError, getPostDetail } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { PostPreview } from '../../../../components/post-preview.tsx';
import { STATUS_LABELS, StatusBadge } from '../../../../components/status-badge.tsx';
import { database } from '../../../../server/context.ts';
import { logDeniedAccess } from '../../../../server/security-log.ts';
import { requireUserId } from '../../../../server/session.ts';
import {
  addPhotosAction,
  editTextAction,
  movePhotoAction,
  refuseAction,
  removePhotoAction,
  requestChangesAction,
  rescheduleAction,
  retryAction,
  validateAction,
  withdrawAction,
} from '../actions.ts';

export const metadata: Metadata = { title: 'Post' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valeur d'un champ datetime-local, dans le fuseau de l'espace. */
function localInputValue(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`;
}

function formatDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { message } = await searchParams;
  if (!UUID.test(id)) notFound();
  const userId = await requireUserId();

  let post;
  try {
    post = await getPostDetail(database(), userId, id, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) {
      logDeniedAccess({ userId, resource: 'post', id });
      notFound();
    }
    throw error;
  }
  const can = new Set(post.actions.commands);

  return (
    <>
      <p>
        <Link href="/">← Mes posts</Link>
      </p>
      <h1>
        {post.accountName} <StatusBadge status={post.status} />
      </h1>
      <p className="departure">{post.departure}</p>
      <Flash code={message} />
      {post.lastError && <p className="flash error">{post.lastError}</p>}
      {post.url && (
        <p>
          <a href={post.url} target="_blank" rel="noopener noreferrer">
            Voir le post sur LinkedIn
          </a>
        </p>
      )}

      <PostPreview accountName={post.accountName} accountKind={post.accountKind} body={post.body} media={post.media} expanded />
      <p className="ai-note">Texte préparé avec l’aide de l’IA : vérifiez les faits, chiffres et noms avant de valider.</p>

      {post.actions.canEdit && (
        <details className="photos">
          <summary>Photos ({post.media.length}/9)</summary>
          {post.media.length > 0 && (
            <ol className="photo-list">
              {post.media.map((item, index) => (
                <li key={item.assetId}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- images privées servies par /media */}
                  <img src={`/media/${item.assetId}`} alt={item.altText ?? `Photo ${index + 1}`} width={72} height={72} />
                  <span>{index === 0 ? 'Couverture' : `Photo ${index + 1}`}</span>
                  <form action={movePhotoAction.bind(null, post.id, item.assetId, 'up')}>
                    <button type="submit" disabled={index === 0} aria-label={`Avancer la photo ${index + 1}`}>
                      ↑
                    </button>
                  </form>
                  <form action={movePhotoAction.bind(null, post.id, item.assetId, 'down')}>
                    <button type="submit" disabled={index === post.media.length - 1} aria-label={`Reculer la photo ${index + 1}`}>
                      ↓
                    </button>
                  </form>
                  <form action={removePhotoAction.bind(null, post.id, item.assetId)}>
                    <button type="submit" aria-label={`Retirer la photo ${index + 1}`}>
                      Retirer
                    </button>
                  </form>
                </li>
              ))}
            </ol>
          )}
          {post.media.length < 9 && (
            <form action={addPhotosAction.bind(null, post.id)} className="stack">
              <label htmlFor="photos">Ajouter des photos (JPG, PNG ou GIF, 10 Mo au plus chacune)</label>
              <input id="photos" name="photos" type="file" accept="image/jpeg,image/png,image/gif" multiple required />
              <button type="submit">Ajouter</button>
            </form>
          )}
        </details>
      )}

      <section className="decide" aria-label="Décision">
        {can.has('validate') && (
          <form action={validateAction.bind(null, post.id)}>
            <button type="submit" className="primary" disabled={post.hasBlockingMarkers} aria-describedby="markers-hint">
              Valider
            </button>
            {post.hasBlockingMarkers && (
              <p id="markers-hint" className="hint">
                Complétez les passages surlignés avant de valider ({post.markers.length}).
              </p>
            )}
          </form>
        )}

        {post.actions.canEdit && (
          <details open={post.hasBlockingMarkers}>
            <summary>Corriger le texte</summary>
            <form action={editTextAction.bind(null, post.id)} className="stack">
              <input type="hidden" name="statut" value={post.status} />
              <label htmlFor="texte">Texte du post</label>
              <textarea id="texte" name="texte" defaultValue={post.body} rows={12} maxLength={3000} required />
              <button type="submit">Enregistrer le texte</button>
            </form>
          </details>
        )}

        {can.has('requestChanges') && (
          <details>
            <summary>Demander une modification</summary>
            <form action={requestChangesAction.bind(null, post.id)} className="stack">
              <label htmlFor="note">Ce qu’il faut changer</label>
              <textarea id="note" name="note" rows={3} required placeholder="Ex. : raccourcir, citer le salon de mars, ton plus personnel…" />
              <button type="submit">Envoyer la demande</button>
            </form>
          </details>
        )}

        {can.has('refuse') && (
          <details>
            <summary>Refuser ce sujet</summary>
            <form action={refuseAction.bind(null, post.id)} className="stack">
              <label htmlFor="motif">Motif</label>
              <select id="motif" name="motif" required defaultValue="">
                <option value="" disabled>
                  Choisir un motif
                </option>
                {Object.entries(REFUSAL_REASONS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <label htmlFor="precision">Précision (obligatoire pour « Autre »)</label>
              <textarea id="precision" name="precision" rows={2} />
              <button type="submit">Refuser</button>
            </form>
          </details>
        )}

        {post.actions.canReschedule && (
          <details>
            <summary>Changer la date et l’heure</summary>
            <form action={rescheduleAction.bind(null, post.id)} className="stack">
              <label htmlFor="creneau">Nouveau créneau (heure de {post.timeZone === 'Europe/Paris' ? 'Paris' : post.timeZone})</label>
              <input id="creneau" name="creneau" type="datetime-local" required defaultValue={localInputValue(post.scheduledAt, post.timeZone)} />
              <button type="submit">Changer le créneau</button>
            </form>
          </details>
        )}

        {can.has('withdraw') && (
          <form action={withdrawAction.bind(null, post.id)}>
            <button type="submit">Retirer la validation</button>
          </form>
        )}
        {can.has('retry') && (
          <form action={retryAction.bind(null, post.id)}>
            <button type="submit" className="primary">
              Réessayer la publication
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="history">
        <h2 id="history">Historique</h2>
        <ol className="history">
          {post.history.map((event, index) => (
            <li key={index}>
              <time dateTime={event.at.toISOString()}>{formatDate(event.at, post.timeZone)}</time> —{' '}
              {event.fromStatus === event.toStatus
                ? event.reason
                : `${event.fromStatus ? STATUS_LABELS[event.fromStatus] : 'Création'} → ${STATUS_LABELS[event.toStatus]}${event.reason ? ` (${event.reason})` : ''}`}
              {event.actorName ? ` · ${event.actorName}` : ' · système'}
            </li>
          ))}
          {post.versions.map((version) => (
            <li key={`v${version.revision}`}>
              <time dateTime={version.createdAt.toISOString()}>{formatDate(version.createdAt, post.timeZone)}</time> — Révision{' '}
              {version.revision} du texte ({version.authorKind === 'ai' ? 'IA' : (version.authorName ?? 'utilisateur')})
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

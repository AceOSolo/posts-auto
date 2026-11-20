import { REFUSAL_REASONS } from '@posts-auto/core';
import { CONTENT_REPORT_DELAY, NotFoundError, getPostDetail, pendingHooks } from '@posts-auto/services';
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
  applyHookAction,
  assistAction,
  editTextAction,
  hooksAction,
  movePhotoAction,
  redoVisualAction,
  refuseAction,
  removePhotoAction,
  requestChangesAction,
  rescheduleAction,
  reportContentAction,
  retryAction,
  carouselAction,
  mentionAction,
  setFirstCommentAction,
  setManualUrlAction,
  validateAction,
  withdrawAction,
} from '../actions.ts';

export const metadata: Metadata = { title: 'Post' };
export const dynamic = 'force-dynamic';

const MENTION_FORMAT = /^@\[[^\]\n]{1,100}\]\(urn:li:organization:\d+\)$/;

/** GEN-08 : retouches proposées au moment de valider. */
const ASSIST_BUTTONS = [
  ['raccourcir', 'Raccourcir'],
  ['ton_direct', 'Plus direct'],
  ['ton_chaleureux', 'Plus chaleureux'],
  ['ton_formel', 'Plus formel'],
  ['regenerer', 'Réécrire entièrement'],
] as const;
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
  const query = await searchParams;
  const message = query['message'];
  // PUB-08 : mention préparée (seul le format exact est affiché).
  const rawMention = typeof query['mention'] === 'string' ? query['mention'] : '';
  const mention = MENTION_FORMAT.test(rawMention) ? rawMention : null;
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
  const hooks = post.actions.canEdit && post.status === 'a_valider' ? await pendingHooks(database(), userId, post.id, new Date()) : [];
  // VIS-13 : le visuel préparé à partir d'un modèle, et ce qu'on peut faire de sa photo.
  const visual = post.media.find((m) => m.kind === 'rendered') ?? null;
  const task = post.visualTask;
  const photoOptions: readonly (readonly [string, string])[] =
    visual === null
      ? [
          ['keep', 'Au choix de l’outil (une fois sur deux avec photo)'],
          ['new', 'Avec une photo'],
          ['none', 'Sans photo (visuel texte)'],
        ]
      : visual.visual?.photo
        ? [
            ['keep', 'Garder la photo'],
            ['new', 'Changer de photo'],
            ['none', 'Sans photo (visuel texte)'],
          ]
        : [
            ['keep', 'Sans photo, comme maintenant'],
            ['new', 'Avec une photo'],
          ];
  const visualOrigin =
    visual?.visual === null || visual === null
      ? null
      : visual.aiGenerated
        ? 'Visuel préparé à partir d’un modèle de l’espace, avec une image générée par IA (signalée dans le texte alternatif publié).'
        : visual.visual.photo !== null
          ? 'Visuel préparé à partir d’un modèle de l’espace, avec une photo de la médiathèque.'
          : 'Visuel texte préparé à partir d’un modèle de l’espace.';

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
      {/* PUB-09 : post envoyé par e-mail pour publication manuelle. */}
      {post.publishedManually && <p className="hint">Envoyé par e-mail au titulaire pour publication manuelle.</p>}
      {post.canSetManualUrl && post.url === null && (
        <form action={setManualUrlAction.bind(null, post.id)} className="inline-fields">
          <label>
            Lien du post publié sur LinkedIn
            <input name="lien" type="url" inputMode="url" placeholder="https://www.linkedin.com/posts/…" required />
          </label>
          <button type="submit">Enregistrer le lien</button>
        </form>
      )}

      <PostPreview accountName={post.accountName} accountKind={post.accountKind} body={post.body} media={post.media} expanded />
      <p className="origin">
        Origine : <strong>{post.origin.label}</strong>
        {post.origin.detail && <> · {post.origin.href ? <Link href={post.origin.href}>{post.origin.detail}</Link> : post.origin.detail}</>}
        {post.origin.versionNo > 1 && <> · reprise n°{post.origin.versionNo - 1}</>}
      </p>
      {post.origin.aiWritten && (
        <p className="ai-note">
          Texte rédigé par une IA : elle peut se tromper. Vérifiez les faits, chiffres et noms avant de valider.{' '}
          <Link href="/comment-fonctionne-la-redaction">Comment fonctionne la rédaction</Link>
        </p>
      )}

      {(visual !== null || task !== null || post.actions.canRedoVisual) && (
        <section className="visual" aria-labelledby="visuel">
          <h2 id="visuel">Visuel</h2>
          {task?.status === 'pending' && (
            <>
              {/* La page se recharge seule tant que le visuel est en préparation (sans JavaScript). */}
              <meta httpEquiv="refresh" content="20" />
              <p className="flash success" role="status">
                Nouveau visuel en préparation{task.instruction ? ` (consigne : « ${task.instruction} »)` : ''}. Cette page se met à jour seule.
              </p>
            </>
          )}
          {task?.status === 'failed' && (
            <p className="flash error" role="alert">
              Le visuel n’a pas pu être préparé ({task.error ?? 'erreur inconnue'}). Vous pouvez réessayer ci-dessous.
            </p>
          )}
          {visual?.visual && (
            <>
              <p className="hint">
                {visualOrigin}
                {visual.visual.instruction && <> Dernière consigne : « {visual.visual.instruction} ».</>}
              </p>
              {visual.visual.issues.length > 0 && (
                <div className="flash error">
                  À vérifier sur le visuel :
                  <ul>
                    {visual.visual.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
              {visual.visual.notes.length > 0 && (
                <ul className="hint">
                  {visual.visual.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {post.actions.canRedoVisual && task?.status !== 'pending' && (
            <details open={task?.status === 'failed'}>
              <summary>{visual === null ? 'Ajouter un visuel' : 'Refaire le visuel'}</summary>
              <form action={redoVisualAction.bind(null, post.id)} className="stack">
                <label htmlFor="consigne">Consigne (facultative)</label>
                <textarea id="consigne" name="consigne" rows={2} maxLength={1000} placeholder="Ex. : titre plus court, mettre le chiffre en avant, photo d’atelier…" />
                <fieldset className="choices">
                  <legend>Photo</legend>
                  {photoOptions.map(([value, label], index) => (
                    <label key={value}>
                      <input type="radio" name="photo" value={value} defaultChecked={index === 0} /> {label}
                    </label>
                  ))}
                </fieldset>
                <button type="submit">{visual === null ? 'Préparer un visuel' : 'Refaire le visuel'}</button>
                <p className="hint">Le nouveau visuel prend la place de l’ancien. Pour mettre votre propre image, ajoutez-la dans « Photos » et retirez le visuel.</p>
              </form>
            </details>
          )}
          {/* VIS-10 : carrousel PDF à partir des points clés du visuel. */}
          {post.actions.canRedoVisual && visual !== null && !visual.isDocument && (
            <form action={carouselAction.bind(null, post.id)}>
              <button type="submit">Faire un carrousel PDF</button>
              <p className="hint">Une page de couverture puis une page par point clé, aux couleurs de la charte. Le carrousel remplace le visuel ; « Refaire le visuel » revient à une image.</p>
            </form>
          )}
        </section>
      )}

      {post.actions.canEdit && post.status === 'a_valider' && (
        <details className="assist" open={hooks.length > 0}>
          <summary>Retravailler avec l’IA</summary>
          <p className="hint">Une nouvelle version du texte est rédigée et vérifiée ; cela prend jusqu’à une minute. L’ancienne reste dans l’historique.</p>
          <div className="actions">
            {ASSIST_BUTTONS.map(([kind, label]) => (
              <form key={kind} action={assistAction.bind(null, post.id, kind)}>
                <button type="submit">{label}</button>
              </form>
            ))}
            <form action={hooksAction.bind(null, post.id)}>
              <button type="submit">Proposer 3 accroches</button>
            </form>
          </div>
          {hooks.length > 0 && (
            <ol className="hooks">
              {hooks.map((hook, index) => (
                <li key={hook}>
                  <span>{hook}</span>
                  <form action={applyHookAction.bind(null, post.id, index)}>
                    <button type="submit">Utiliser cette accroche</button>
                  </form>
                </li>
              ))}
            </ol>
          )}
        </details>
      )}

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

      {/* PUB-08 : mention d'une page d'entreprise, au format de l'API LinkedIn. */}
      {post.actions.canEdit && (
        <section aria-labelledby="mention-titre" id="mention">
          <h2 id="mention-titre">Mentionner une page</h2>
          {mention !== null && (
            <p className="flash success" role="status">
              Copiez cette mention à l’endroit voulu du texte : <code>{mention}</code> (elle s’affichera « @{mention.slice(2, mention.indexOf(']'))} » sur LinkedIn).
            </p>
          )}
          <p className="hint">Collez l’adresse de la page LinkedIn de l’entreprise à mentionner. Un « @ » tapé à la main n’est pas transmis à LinkedIn et bloque la validation.</p>
          <form action={mentionAction.bind(null, post.id)} className="inline-fields">
            <label>
              Adresse de la page
              <input name="page" type="url" inputMode="url" placeholder="https://www.linkedin.com/company/…" required />
            </label>
            <button type="submit">Préparer la mention</button>
          </form>
        </section>
      )}

      {/* PUB-07 : premier commentaire, publié juste après le post. */}
      {(post.actions.canEdit || post.firstComment !== null) && (
        <section aria-labelledby="premier-commentaire" id="commentaire">
          <h2 id="premier-commentaire">Premier commentaire</h2>
          {post.firstCommentStatus === 'posted' && <p className="muted">Publié sous le post.</p>}
          {post.firstCommentStatus === 'failed' && <p className="flash error">Le commentaire n’a pas pu être publié : {post.firstCommentError}</p>}
          {post.actions.canEdit ? (
            <form action={setFirstCommentAction.bind(null, post.id)} className="stack">
              <label htmlFor="commentaire-texte">Publié automatiquement juste après le post (un lien, un complément). Vide : pas de commentaire.</label>
              <textarea id="commentaire-texte" name="commentaire" rows={3} maxLength={1250} defaultValue={post.firstComment ?? ''} />
              <button type="submit">Enregistrer le commentaire</button>
            </form>
          ) : (
            <p className="pre">{post.firstComment}</p>
          )}
        </section>
      )}

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

      <details className="report">
        <summary>Signaler un contenu</summary>
        <form action={reportContentAction.bind(null, post.id)} className="stack">
          <p className="hint">
            Un texte ou une image qui pose problème (erreur, propos inappropriés, contenu protégé) ? L’éditeur du produit examine chaque signalement sous{' '}
            {CONTENT_REPORT_DELAY}.
          </p>
          <label htmlFor="motif">Ce qui pose problème</label>
          <textarea id="motif" name="motif" rows={3} required maxLength={2000} />
          <button type="submit">Envoyer le signalement</button>
        </form>
      </details>
    </>
  );
}

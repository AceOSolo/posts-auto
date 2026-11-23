import { REFUSAL_REASONS, markerQuestions } from '@posts-auto/core';
import { CONTENT_REPORT_DELAY, NotFoundError, getPostDetail, listMyPosts, pendingHooks } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { PageHeader } from '../../../../components/page-header.tsx';
import decision from '../../../../components/post-decision.module.css';
import { PostPreview } from '../../../../components/post-preview.tsx';
import { STATUS_LABELS, StatusBadge } from '../../../../components/status-badge.tsx';
import { database } from '../../../../server/context.ts';
import { logDeniedAccess } from '../../../../server/security-log.ts';
import { requireUserId } from '../../../../server/session.ts';
import {
  addPhotosAction,
  applyHookAction,
  assistAction,
  completeMarkersAction,
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
import styles from '../post-page.module.css';

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

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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
  const messageCode = typeof message === 'string' ? message : '';
  // PUB-08 : mention préparée (seul le format exact est affiché).
  const rawMention = typeof query['mention'] === 'string' ? query['mention'] : '';
  const mention = MENTION_FORMAT.test(rawMention) ? rawMention : null;
  if (!UUID.test(id)) notFound();
  const userId = await requireUserId();
  const now = new Date();

  let post;
  try {
    post = await getPostDetail(database(), userId, id, now);
  } catch (error) {
    if (error instanceof NotFoundError) {
      logDeniedAccess({ userId, resource: 'post', id });
      notFound();
    }
    throw error;
  }
  const can = new Set(post.actions.commands);
  const canModify = post.actions.canEdit || can.has('requestChanges');
  // VAL-03 : un passage qui se résume à une question se complète sans ouvrir tout le texte.
  const questions = post.status === 'a_valider' && post.actions.canEdit ? markerQuestions(post.body) : [];
  // Sans JavaScript : le panneau ouvert est porté par l'adresse. Un passage à relire ouvre la correction.
  const modifyOpen = canModify && (query['action'] === 'modifier' || (post.hasBlockingMarkers && post.actions.canEdit && questions.length === 0));
  const refuseOpen = can.has('refuse') && query['action'] === 'refuser';
  const dateOpen = post.actions.canReschedule && query['action'] === 'date';
  const hooks = post.actions.canEdit && post.status === 'a_valider' ? await pendingHooks(database(), userId, post.id, now) : [];

  // Les posts qui attendent encore une décision, pour enchaîner sans repasser par la liste.
  const queue = (await listMyPosts(database(), userId, now)).filter((item) => item.status === 'a_valider');
  const position = queue.findIndex((item) => item.id === post.id);
  const following = position >= 0 ? queue[position + 1] : undefined;
  const nextAfterDecision = position < 0 ? queue[0] : undefined;

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

  // « Plus d'options » s'ouvre seul quand une de ses parties demande de l'attention ou vient de servir.
  const showVisual = visual !== null || task !== null || post.actions.canRedoVisual;
  const visualOpen = task?.status === 'pending' || task?.status === 'failed' || (visual?.visual?.issues.length ?? 0) > 0 || messageCode.startsWith('visuel') || messageCode.startsWith('carrousel');
  const assistOpen = hooks.length > 0 || messageCode.startsWith('accroche');
  const photosOpen = messageCode.startsWith('photo');
  const commentOpen = post.firstCommentStatus === 'failed' || messageCode.startsWith('commentaire');
  const mentionOpen = mention !== null || messageCode.startsWith('mention');
  const moreOpen = (showVisual && visualOpen) || assistOpen || photosOpen || commentOpen || mentionOpen;

  return (
    <>
      <p className="back-link">
        <Link href="/">← Mes posts</Link>
      </p>
      <PageHeader
        title={
          <>
            {post.accountName} <StatusBadge status={post.status} />
          </>
        }
        {...(position >= 0 && {
          description: (
            <>
              Post {position + 1} sur {queue.length}
              {following !== undefined && (
                <>
                  {' · '}
                  <Link href={`/posts/${following.id}`}>Passer au suivant</Link>
                </>
              )}
            </>
          ),
        })}
      />
      <Flash code={message} />

      <div className={styles.layout}>
        <div className={styles.post}>
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

          {modifyOpen && (
            <div className={decision.panel}>
              {post.actions.canEdit && (
                <form action={editTextAction.bind(null, post.id)} className="stack">
                  <input type="hidden" name="statut" value={post.status} />
                  <label htmlFor="texte">Corriger le texte moi-même</label>
                  <textarea id="texte" name="texte" defaultValue={post.body} rows={12} maxLength={3000} required />
                  <button type="submit">Enregistrer le texte</button>
                </form>
              )}
              {can.has('requestChanges') && (
                <form action={requestChangesAction.bind(null, post.id)} className="stack">
                  <label htmlFor="note">Ou demander à l’IA de le refaire</label>
                  <textarea id="note" name="note" rows={3} required placeholder="Ex. : raccourcir, citer le salon de mars, ton plus personnel…" />
                  <button type="submit">Envoyer la demande</button>
                </form>
              )}
            </div>
          )}
        </div>

        {/* VAL-02 : la décision, toujours au même endroit. */}
        <aside id="decision" className={styles.side} aria-label="Décision">
          <div className={styles.when}>
            <p className="departure">{post.departure}</p>
            {post.actions.canReschedule && <Link href={dateOpen ? `/posts/${post.id}#decision` : `/posts/${post.id}?action=date#decision`}>{dateOpen ? 'Fermer' : 'Changer'}</Link>}
          </div>
          {dateOpen && (
            <form action={rescheduleAction.bind(null, post.id)} className="stack">
              <label htmlFor="creneau">Nouveau créneau (heure de {post.timeZone === 'Europe/Paris' ? 'Paris' : post.timeZone})</label>
              <input id="creneau" name="creneau" type="datetime-local" required defaultValue={localInputValue(post.scheduledAt, post.timeZone)} />
              <button type="submit">Changer le créneau</button>
            </form>
          )}

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
            <form action={setManualUrlAction.bind(null, post.id)} className="stack">
              <label htmlFor="lien">Lien du post publié sur LinkedIn</label>
              <input id="lien" name="lien" type="url" inputMode="url" placeholder="https://www.linkedin.com/posts/…" required />
              <button type="submit">Enregistrer le lien</button>
            </form>
          )}

          {questions.length > 0 && (
            <form action={completeMarkersAction.bind(null, post.id)} className={styles.fill}>
              <input type="hidden" name="texte" value={post.body} />
              {questions.map((question, index) => (
                <div key={question.start} className="stack">
                  <label htmlFor={`complement-${index}`}>{capitalized(question.label)}</label>
                  <input id={`complement-${index}`} name="complement" required maxLength={300} />
                </div>
              ))}
              <button type="submit">Compléter le post</button>
            </form>
          )}

          {(can.has('validate') || canModify || can.has('refuse')) && (
            <div className={`${decision.bar} ${decision.stacked}`}>
              {can.has('validate') && (
                <form action={validateAction.bind(null, post.id)}>
                  <button
                    type="submit"
                    className={`primary ${decision.action} ${decision.validate}`}
                    disabled={post.hasBlockingMarkers}
                    {...(post.hasBlockingMarkers ? { 'aria-describedby': 'markers-hint' } : {})}
                  >
                    Valider
                  </button>
                </form>
              )}
              {canModify && (
                <Link
                  href={modifyOpen ? `/posts/${post.id}#decision` : `/posts/${post.id}?action=modifier#decision`}
                  className={`button ${decision.action} ${decision.modify} ${modifyOpen ? decision.current : ''}`}
                  aria-expanded={modifyOpen}
                >
                  Modifier
                </Link>
              )}
              {can.has('refuse') && (
                <Link
                  href={refuseOpen ? `/posts/${post.id}#decision` : `/posts/${post.id}?action=refuser#decision`}
                  className={`button ${decision.action} ${decision.refuse} ${refuseOpen ? decision.current : ''}`}
                  aria-expanded={refuseOpen}
                >
                  Refuser
                </Link>
              )}
            </div>
          )}
          {can.has('validate') && post.hasBlockingMarkers && (
            <p id="markers-hint" className="hint">
              {questions.length > 0 ? 'Complétez ce qui manque pour pouvoir valider.' : `Complétez les passages surlignés avant de valider (${post.markers.length}).`}
            </p>
          )}

          {refuseOpen && (
            <div className={decision.panel}>
              <h3>Pourquoi refuser ce sujet ?</h3>
              <form action={refuseAction.bind(null, post.id)} className={decision.reasons}>
                {Object.entries(REFUSAL_REASONS)
                  .filter(([value]) => value !== 'autre')
                  .map(([value, label]) => (
                    <button key={value} type="submit" name="motif" value={value}>
                      {label}
                    </button>
                  ))}
              </form>
              <form action={refuseAction.bind(null, post.id)} className="stack">
                <input type="hidden" name="motif" value="autre" />
                <label htmlFor="precision">Autre raison</label>
                <textarea id="precision" name="precision" rows={2} required />
                <button type="submit">Refuser</button>
              </form>
              <Link href={`/posts/${post.id}#decision`} className={decision.close}>
                Annuler
              </Link>
            </div>
          )}

          {can.has('retry') && (
            <form action={retryAction.bind(null, post.id)}>
              <button type="submit" className="primary">
                Réessayer la publication
              </button>
            </form>
          )}
          {can.has('withdraw') && (
            <form action={withdrawAction.bind(null, post.id)}>
              <button type="submit">Retirer la validation</button>
            </form>
          )}
          {nextAfterDecision !== undefined && (
            <Link href={`/posts/${nextAfterDecision.id}`} className="button primary">
              Post suivant
            </Link>
          )}
        </aside>
      </div>

      <details className={styles.more} open={moreOpen}>
        <summary>Plus d’options</summary>
        <div className="decide">
          {showVisual && (
            <details id="visuel" open={visualOpen}>
              <summary>Visuel</summary>
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
              )}
              {/* VIS-10 : carrousel PDF à partir des points clés du visuel. */}
              {post.actions.canRedoVisual && visual !== null && !visual.isDocument && (
                <form action={carouselAction.bind(null, post.id)}>
                  <button type="submit">Faire un carrousel PDF</button>
                  <p className="hint">Une page de couverture puis une page par point clé, aux couleurs de la charte. Le carrousel remplace le visuel ; « Refaire le visuel » revient à une image.</p>
                </form>
              )}
            </details>
          )}

          {post.actions.canEdit && post.status === 'a_valider' && (
            <details className="assist" open={assistOpen}>
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
            <details className="photos" open={photosOpen}>
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

          {/* PUB-07 : premier commentaire, publié juste après le post. */}
          {(post.actions.canEdit || post.firstComment !== null) && (
            <details id="commentaire" open={commentOpen}>
              <summary>Premier commentaire</summary>
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
            </details>
          )}

          {/* PUB-08 : mention d'une page d'entreprise, au format de l'API LinkedIn. */}
          {post.actions.canEdit && (
            <details id="mention" open={mentionOpen}>
              <summary>Mentionner une page</summary>
              {mention !== null && (
                <p className="flash success" role="status">
                  Copiez cette mention à l’endroit voulu du texte : <code>{mention}</code> (elle s’affichera « @{mention.slice(2, mention.indexOf(']'))} » sur LinkedIn).
                </p>
              )}
              <p className="hint">Collez l’adresse de la page LinkedIn de l’entreprise à mentionner. Un « @ » tapé à la main n’est pas transmis à LinkedIn et bloque la validation.</p>
              <form action={mentionAction.bind(null, post.id)} className="stack">
                <label htmlFor="mention-page">Adresse de la page</label>
                <input id="mention-page" name="page" type="url" inputMode="url" placeholder="https://www.linkedin.com/company/…" required />
                <button type="submit">Préparer la mention</button>
              </form>
            </details>
          )}

          <details>
            <summary>Historique</summary>
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
          </details>

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
        </div>
      </details>
    </>
  );
}

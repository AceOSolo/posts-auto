import {
  AVATAR_CONSENT_TEXT,
  IMAGE_RATIOS,
  NotFoundError,
  TIME_BANDS,
  WEEKDAY_NAMES,
  accountAvatar,
  getAccountProfile,
  getLearnedPreferences,
  listReferencePosts,
  postingTimesAdvice,
} from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../../components/flash.tsx';
import { database } from '../../../../../../server/context.ts';
import { requireUserId } from '../../../../../../server/session.ts';
import { addExampleAction, addSuggestedSlotAction, declareAvatarAction, deleteExampleAction, revokeAvatarAction, savePreferencesAction, saveProfileAction } from '../../../fiche-actions.ts';
import { SLOT_ROWS } from '../../../fiche-constants.ts';

export const metadata: Metadata = { title: 'Fiche du compte' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEKDAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const SENSITIVITY: Record<string, string> = {
  standard: 'Standard',
  prudent: 'Prudent : pas d’humour, pas de sujet clivant',
  strict: 'Strict : faits vérifiés seulement, ton institutionnel',
};

/** EDI-04 à EDI-06 : fiche du compte, exemples de référence, préférences apprises. */
export default async function AccountProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, accountId } = await params;
  const { message } = await searchParams;
  if (!UUID.test(workspaceId) || !UUID.test(accountId)) notFound();
  const userId = await requireUserId();
  const db = database();
  let data;
  try {
    data = await Promise.all([getAccountProfile(db, userId, accountId), listReferencePosts(db, userId, accountId), getLearnedPreferences(db, userId, accountId), accountAvatar(db, userId, accountId)]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [{ profile, rights }, examples, preferences, avatar] = data;
  const isHolder = profile.holderUserId === userId;
  if (profile.workspaceId !== workspaceId) notFound();
  const canEditExamples = rights.canEditAll || rights.canEditOwn;
  const lockAll = !rights.canEditAll;
  const moments = await postingTimesAdvice(db, userId, accountId, new Date(), profile.usualSlots);
  const unit = moments.metric === 'taux' ? 'interactions pour 1 000 impressions' : 'interactions par post';

  return (
    <>
      <p>
        <Link href={`/comptes/${workspaceId}`}>← Comptes</Link>
      </p>
      <h1>
        {profile.displayName ?? 'Compte'} <small className="muted">· {profile.kind === 'page' ? 'Page' : 'Profil'}</small>
      </h1>
      <Flash code={message} />

      <section aria-labelledby="fiche-titre" id="fiche">
        <h2 id="fiche-titre">Fiche du compte</h2>
        <form action={saveProfileAction.bind(null, workspaceId, accountId)} className="stack">
          <fieldset disabled={lockAll}>
            <legend>Voix et rythme</legend>
            <div className="stack">
              <label htmlFor="voix">Voix</label>
              <select id="voix" name="voix" defaultValue={profile.voice ?? ''}>
                <option value="">Non précisée</option>
                <option value="je">« Je »</option>
                <option value="nous">« Nous »</option>
              </select>
              <label htmlFor="sensibilite">Sensibilité</label>
              <select id="sensibilite" name="sensibilite" defaultValue={profile.sensitivity}>
                {Object.entries(SENSITIVITY).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <label htmlFor="rythme">Posts par semaine</label>
              <input id="rythme" name="rythme" type="number" min={0} max={14} defaultValue={profile.postsPerWeek} />
              <label htmlFor="options">Posts en option par semaine</label>
              <input id="options" name="options" type="number" min={0} max={14} defaultValue={profile.optionalPerWeek} />
              <label htmlFor="part-photos">Visuels avec photo (VIS-04)</label>
              <select id="part-photos" name="part-photos" defaultValue={String(profile.aiImageRatio)} aria-describedby="part-photos-aide">
                {IMAGE_RATIOS.map((ratio) => (
                  <option key={ratio.value} value={String(ratio.value)}>
                    {ratio.label}
                  </option>
                ))}
              </select>
              <p id="part-photos-aide" className="hint">
                Les autres visuels sont des visuels texte. La photo vient de la médiathèque quand l’une convient, sinon elle est générée par IA (dans la limite du budget de l’espace).
              </p>
            </div>
          </fieldset>
          <fieldset disabled={lockAll}>
            <legend>Créneaux habituels (heure de Paris)</legend>
            {Array.from({ length: SLOT_ROWS }, (_, i) => {
              const slot = profile.usualSlots[i];
              return (
                <div key={i} className="inline-fields">
                  <label htmlFor={`jour-${i}`} className="visually-hidden">
                    Jour du créneau {i + 1}
                  </label>
                  <select id={`jour-${i}`} name={`jour-${i}`} defaultValue={slot?.weekday ?? ''}>
                    <option value="">—</option>
                    {WEEKDAYS.slice(1).map((day, index) => (
                      <option key={day} value={index + 1}>
                        {day}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`heure-${i}`} className="visually-hidden">
                    Heure du créneau {i + 1}
                  </label>
                  <input id={`heure-${i}`} name={`heure-${i}`} type="time" step={300} defaultValue={slot?.time ?? ''} />
                </div>
              );
            })}
          </fieldset>
          <fieldset disabled={!rights.canEditAll && !rights.canEditOwn}>
            <legend>Ton et sujets</legend>
            <div className="stack">
              <label htmlFor="teneur">Teneur et ton propres au compte</label>
              <textarea id="teneur" name="teneur" rows={3} defaultValue={profile.tenor ?? ''} />
              <label htmlFor="a-eviter">Sujets à éviter</label>
              <textarea id="a-eviter" name="a-eviter" rows={3} defaultValue={profile.avoid ?? ''} />
            </div>
          </fieldset>
          {(rights.canEditAll || rights.canEditOwn) && (
            <button type="submit" className="primary">
              Enregistrer la fiche
            </button>
          )}
          {!rights.canEditAll && rights.canEditOwn && <p className="hint">En tant que titulaire, vous réglez le ton et les sujets à éviter.</p>}
        </form>
      </section>

      <section aria-labelledby="moments-titre" id="moments">
        <h2 id="moments-titre">Meilleurs moments pour publier</h2>
        {moments.groups.length === 0 ? (
          <p className="muted">
            Pas encore assez de posts mesurés pour conseiller un moment : {moments.measured} sur {moments.needed} (statistiques LinkedIn relevées une semaine après la publication, sur les six
            derniers mois).
          </p>
        ) : (
          <>
            {moments.best === null ? (
              <p>Aucun moment ne se détache nettement pour l’instant : les créneaux actuels conviennent.</p>
            ) : (
              <p>
                {`Les posts publiés le ${WEEKDAY_NAMES[moments.best.weekday]} ${TIME_BANDS[moments.best.band].label} marchent le mieux : ${moments.gainPercent} % d’engagement de plus que la moyenne du compte.`}
                {moments.alreadyUsed && ' Un créneau habituel est déjà placé à ce moment.'}
              </p>
            )}
            {moments.best !== null && !moments.alreadyUsed && rights.canEditAll && (
              <form action={addSuggestedSlotAction.bind(null, workspaceId, accountId)} className="inline-fields">
                <input type="hidden" name="jour" value={moments.best.weekday} />
                <input type="hidden" name="heure" value={moments.best.suggestedTime} />
                <button type="submit">{`Ajouter le créneau du ${WEEKDAY_NAMES[moments.best.weekday]} à ${moments.best.suggestedTime.replace(':', ' h ')}`}</button>
              </form>
            )}
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Tableau, défilable horizontalement">
              <table>
                <caption className="visually-hidden">Engagement par moment de publication</caption>
                <thead>
                  <tr>
                    <th scope="col">Moment</th>
                    <th scope="col">Posts mesurés</th>
                    <th scope="col">Engagement ({unit})</th>
                    <th scope="col">Impressions moyennes</th>
                  </tr>
                </thead>
                <tbody>
                  {moments.groups.map((g) => (
                    <tr key={`${g.weekday}-${g.band}`}>
                      <th scope="row">{`${WEEKDAY_NAMES[g.weekday]} ${TIME_BANDS[g.band].label}`}</th>
                      <td>{g.posts}</td>
                      <td>{g.score.toLocaleString('fr-FR')}</td>
                      <td>{g.averageImpressions === null ? '—' : g.averageImpressions.toLocaleString('fr-FR')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">Interactions : réactions, commentaires comptés double, partages comptés triple. Seuls les moments d’au moins deux posts sont classés.</p>
          </>
        )}
      </section>

      <section aria-labelledby="exemples-titre" id="exemples">
        <h2 id="exemples-titre">Exemples de référence</h2>
        <p className="hint">Des posts dont l’IA doit s’inspirer, ou qu’elle doit éviter. Ils servent de modèle de style, jamais de consigne.</p>
        {examples.length === 0 && <p className="muted">Aucun exemple pour l’instant.</p>}
        <ul className="cards">
          {examples.map((example) => (
            <li key={example.id} className="card">
              <span className={`badge ${example.label === 'imiter' ? 'status-publie' : 'status-erreur'}`}>{example.label === 'imiter' ? 'À imiter' : 'À éviter'}</span>
              <p className="pre">{example.body}</p>
              {example.note && <p className="muted">{example.note}</p>}
              {canEditExamples && (
                <form action={deleteExampleAction.bind(null, workspaceId, accountId, example.id)}>
                  <button type="submit">Supprimer</button>
                </form>
              )}
            </li>
          ))}
        </ul>
        {canEditExamples && (
          <details open={examples.length === 0}>
            <summary>Ajouter un exemple</summary>
            <form action={addExampleAction.bind(null, workspaceId, accountId)} className="stack">
              <label htmlFor="texte">Texte du post</label>
              <textarea id="texte" name="texte" rows={6} required maxLength={5000} />
              <fieldset>
                <legend>Cet exemple est</legend>
                <label className="check">
                  <input type="radio" name="etiquette" value="imiter" defaultChecked /> À imiter
                </label>
                <label className="check">
                  <input type="radio" name="etiquette" value="eviter" /> À éviter
                </label>
              </fieldset>
              <label htmlFor="note">Pourquoi (facultatif)</label>
              <input id="note" name="note" maxLength={500} />
              <button type="submit" className="primary">
                Ajouter
              </button>
            </form>
          </details>
        )}
      </section>

      <section aria-labelledby="preferences-titre" id="preferences">
        <h2 id="preferences-titre">Préférences apprises</h2>
        <p className="hint">Résumé de ce que le titulaire corrige ou refuse le plus souvent, mis à jour chaque jour à partir de ses corrections, de ses demandes de modification et de ses refus. Il est utilisé à chaque rédaction ; vous pouvez le modifier, ce que vous écrivez est gardé.</p>
        <form action={savePreferencesAction.bind(null, workspaceId, accountId)} className="stack">
          <label htmlFor="resume" className="visually-hidden">
            Préférences apprises
          </label>
          <textarea id="resume" name="resume" rows={5} maxLength={4000} defaultValue={preferences.summary} disabled={!canEditExamples} />
          {canEditExamples && <button type="submit">Enregistrer les préférences</button>}
        </form>
      </section>

      {/* VIS-06 : personnage de marque, sur les posts de ce compte seulement. */}
      {profile.kind === 'profile' && (isHolder || rights.canEditAll) && (
        <section aria-labelledby="avatar-titre" id="avatar">
          <h2 id="avatar-titre">Avatar de marque</h2>
          <p className="hint">
            Une image générée qui représente le titulaire peut illustrer les visuels de ses propres posts, à la place d’une image générée anonyme. Elle n’est jamais utilisée sur un autre
            compte et porte la mention « image générée par IA ».
          </p>
          {avatar !== null ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- image privée servie par /media */}
              <img src={`/media/${avatar.assetId}`} alt="Avatar du titulaire" height={120} className="logo-preview" />
              <p className="muted">Autorisé par le titulaire le {new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(avatar.consentedAt)}.</p>
              <form action={revokeAvatarAction.bind(null, workspaceId, accountId)}>
                <button type="submit">Retirer l’avatar</button>
              </form>
            </>
          ) : isHolder ? (
            <form action={declareAvatarAction.bind(null, workspaceId, accountId)} className="stack">
              <label htmlFor="avatar-image">Image de l’avatar (PNG ou JPEG)</label>
              <input id="avatar-image" name="avatar" type="file" accept="image/png,image/jpeg" required />
              <label className="check">
                <input type="checkbox" name="accord" required /> {AVATAR_CONSENT_TEXT}
              </label>
              <button type="submit">Déclarer mon avatar</button>
            </form>
          ) : (
            <p className="muted">Seul le titulaire peut déclarer son avatar.</p>
          )}
        </section>
      )}
    </>
  );
}

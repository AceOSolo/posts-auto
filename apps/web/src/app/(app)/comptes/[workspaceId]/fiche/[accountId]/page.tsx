import { NotFoundError, getAccountProfile, getLearnedPreferences, listReferencePosts } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../../components/flash.tsx';
import { database } from '../../../../../../server/context.ts';
import { requireUserId } from '../../../../../../server/session.ts';
import { addExampleAction, deleteExampleAction, savePreferencesAction, saveProfileAction } from '../../../fiche-actions.ts';
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
    data = await Promise.all([getAccountProfile(db, userId, accountId), listReferencePosts(db, userId, accountId), getLearnedPreferences(db, userId, accountId)]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [{ profile, rights }, examples, preferences] = data;
  if (profile.workspaceId !== workspaceId) notFound();
  const canEditExamples = rights.canEditAll || rights.canEditOwn;
  const lockAll = !rights.canEditAll;

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
        <p className="hint">Résumé de ce que le titulaire corrige ou refuse le plus souvent. Il est utilisé à chaque rédaction ; vous pouvez le modifier.</p>
        <form action={savePreferencesAction.bind(null, workspaceId, accountId)} className="stack">
          <label htmlFor="resume" className="visually-hidden">
            Préférences apprises
          </label>
          <textarea id="resume" name="resume" rows={5} maxLength={4000} defaultValue={preferences.summary} disabled={!canEditExamples} />
          {canEditExamples && <button type="submit">Enregistrer les préférences</button>}
        </form>
      </section>
    </>
  );
}

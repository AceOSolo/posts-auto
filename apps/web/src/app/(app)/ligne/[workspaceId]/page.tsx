import { NotFoundError, type OfferItem, editorialHistory, getEditorialLine, listOffer } from '@posts-auto/services';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { deleteOfferAction, saveLineAction, saveOfferAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Ligne éditoriale' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVAILABILITY: Record<OfferItem['status'], string> = {
  available: 'Disponible',
  planned: 'En préparation (jamais présentée comme disponible)',
  retired: 'Retirée',
};
const PRICING: Record<string, string> = { free: 'Gratuite', paid: 'Payante', '': 'Non précisé' };

function OfferFields({ item }: { item?: OfferItem }) {
  const prefix = item?.id ?? 'nouvelle';
  return (
    <>
      <label htmlFor={`nom-${prefix}`}>Nom</label>
      <input id={`nom-${prefix}`} name="nom" required maxLength={200} defaultValue={item?.name ?? ''} />
      <label htmlFor={`description-${prefix}`}>Description</label>
      <textarea id={`description-${prefix}`} name="description" rows={2} maxLength={2000} defaultValue={item?.description ?? ''} />
      <label htmlFor={`disponibilite-${prefix}`}>Disponibilité</label>
      <select id={`disponibilite-${prefix}`} name="disponibilite" defaultValue={item?.status ?? 'available'}>
        {Object.entries(AVAILABILITY).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor={`prix-${prefix}`}>Prix</label>
      <select id={`prix-${prefix}`} name="prix" defaultValue={item?.pricing ?? ''}>
        {Object.entries(PRICING).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </>
  );
}

/** EDI-01, EDI-02, EDI-03, EDI-07 : ligne éditoriale, règles communes, état de l'offre, historique. */
export default async function EditorialLinePage({
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
  const db = database();
  let data;
  try {
    data = await Promise.all([getEditorialLine(db, userId, workspaceId), listOffer(db, userId, workspaceId), editorialHistory(db, userId, workspaceId)]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [{ line, canEdit }, offer, history] = data;
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' });
  const readOnly = !canEdit;

  return (
    <>
      <h1>Ligne éditoriale</h1>
      <Flash code={message} />
      <p className="hint">
        L’IA rédige à partir de ces informations. Elle ne cite que ce qui figure ici et dans l’état de l’offre : rien n’est inventé, ce qui manque est
        signalé par un marqueur [À COMPLÉTER] qui bloque la publication.
      </p>

      <section aria-labelledby="ligne-titre" id="ligne">
        <h2 id="ligne-titre">
          Ligne en vigueur {line.version > 0 && <small>· version {line.version}</small>}
        </h2>
        <form action={saveLineAction.bind(null, workspaceId)} className="stack">
          <fieldset disabled={readOnly}>
            <legend>Ce que l’entreprise dit d’elle</legend>
            <div className="stack">
              <label htmlFor="positionnement">Positionnement</label>
              <textarea id="positionnement" name="positionnement" rows={3} defaultValue={line.positioning ?? ''} />
              <label htmlFor="offres">Offres (présentation générale)</label>
              <textarea id="offres" name="offres" rows={3} defaultValue={line.offers ?? ''} />
              <label htmlFor="cibles">Cibles</label>
              <textarea id="cibles" name="cibles" rows={2} defaultValue={line.audiences ?? ''} />
              <label htmlFor="preuves">Preuves autorisées</label>
              <textarea id="preuves" name="preuves" rows={3} defaultValue={line.allowedProofs ?? ''} aria-describedby="preuves-aide" />
              <p id="preuves-aide" className="hint">
                Chiffres, références clients (avec leur accord), labels : seules ces preuves peuvent être citées.
              </p>
              <label htmlFor="ton">Ton</label>
              <textarea id="ton" name="ton" rows={2} defaultValue={line.tone ?? ''} />
              <label htmlFor="interdits">Mots et formules interdits (un par ligne)</label>
              <textarea id="interdits" name="interdits" rows={3} defaultValue={line.bannedPhrases.join('\n')} />
            </div>
          </fieldset>
          <fieldset disabled={readOnly}>
            <legend>Règles communes</legend>
            <div className="stack">
              <label htmlFor="hashtags">Hashtags au plus</label>
              <input id="hashtags" name="hashtags" type="number" min={0} max={30} defaultValue={line.rules.maxHashtags} />
              <label htmlFor="emojis">Emojis</label>
              <select id="emojis" name="emojis" defaultValue={line.rules.emojis}>
                <option value="none">Aucun</option>
                <option value="rare">Rares (2 au plus)</option>
                <option value="free">Libres</option>
              </select>
              <label htmlFor="longueur-min">Longueur minimale (caractères)</label>
              <input id="longueur-min" name="longueur-min" type="number" min={0} max={3000} defaultValue={line.rules.minLength} />
              <label htmlFor="longueur-max">Longueur maximale (caractères)</label>
              <input id="longueur-max" name="longueur-max" type="number" min={1} max={3000} defaultValue={line.rules.maxLength} />
              <label className="check">
                <input type="checkbox" name="liens-en-fin" defaultChecked={line.rules.linksAtEnd} /> Liens en fin de texte
              </label>
              <label className="check">
                <input type="checkbox" name="question" defaultChecked={line.rules.askQuestion} /> Une question posée au lecteur
              </label>
              <p className="hint">Pas de mention @ pour l’instant ; l’accroche doit tenir dans les 2 premières lignes.</p>
            </div>
          </fieldset>
          {canEdit && (
            <button type="submit" className="primary">
              Enregistrer une nouvelle version
            </button>
          )}
        </form>
        {line.savedAt && (
          <p className="muted">
            Dernière modification le {dateFormat.format(line.savedAt)}
            {line.savedBy && ` par ${line.savedBy}`}.
          </p>
        )}
      </section>

      <section aria-labelledby="offre-titre" id="offre">
        <h2 id="offre-titre">État de l’offre</h2>
        <p className="hint">L’IA ne présente comme disponible que ce qui est marqué « Disponible ».</p>
        {offer.items.length === 0 && <p className="muted">Aucune offre renseignée.</p>}
        <ul className="cards">
          {offer.items.map((item) => (
            <li key={item.id} className="card">
              {offer.canEdit ? (
                <>
                  <form action={saveOfferAction.bind(null, workspaceId, item.id)} className="stack">
                    <OfferFields item={item} />
                    <button type="submit">Enregistrer</button>
                  </form>
                  <form action={deleteOfferAction.bind(null, workspaceId, item.id)}>
                    <button type="submit">Supprimer</button>
                  </form>
                </>
              ) : (
                <>
                  <strong>{item.name}</strong>
                  <p>
                    {AVAILABILITY[item.status]} · {PRICING[item.pricing ?? '']}
                  </p>
                  {item.description && <p className="muted">{item.description}</p>}
                </>
              )}
            </li>
          ))}
        </ul>
        {offer.canEdit && (
          <details open={offer.items.length === 0}>
            <summary>Ajouter une offre</summary>
            <form action={saveOfferAction.bind(null, workspaceId, null)} className="stack">
              <OfferFields />
              <button type="submit" className="primary">
                Ajouter
              </button>
            </form>
          </details>
        )}
      </section>

      {history.length > 0 && (
        <section aria-labelledby="historique">
          <h2 id="historique">Historique</h2>
          <ul className="notification-list">
            {history.map((entry) => (
              <li key={entry.version}>
                <span>
                  Version {entry.version} : {entry.changed.join(', ')}
                </span>
                <time dateTime={entry.savedAt.toISOString()}>
                  {dateFormat.format(entry.savedAt)}
                  {entry.savedBy && ` · ${entry.savedBy}`}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

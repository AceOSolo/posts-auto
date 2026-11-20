import { type EditorialProposal, NotFoundError, type OfferItem, editorialHistory, getEditorialLine, getOnboarding, listOffer, listSources } from '@posts-auto/services';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { database, mediaStore } from '../../../../server/context.ts';
import { editorialProposalKey } from '../../../../server/drafts.ts';
import { requireUserId } from '../../../../server/session.ts';
import { addSourceAction, deleteOfferAction, deleteSourceAction, proposeLineAction, saveLineAction, saveOfferAction, toggleSourceAction } from '../actions.ts';

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
  const { message, proposition } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const db = database();
  let data;
  try {
    data = await Promise.all([getEditorialLine(db, userId, workspaceId), listOffer(db, userId, workspaceId), editorialHistory(db, userId, workspaceId), listSources(db, userId, workspaceId)]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [{ line, canEdit }, offer, history, sources] = data;
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' });
  const readOnly = !canEdit;
  // ONB-04 : proposition de l'IA en cours de relecture (rien n'est enregistré avant validation).
  let proposal: EditorialProposal | null = null;
  if (canEdit && typeof proposition === 'string' && UUID.test(proposition)) {
    try {
      proposal = JSON.parse(new TextDecoder().decode(await mediaStore().read(editorialProposalKey(workspaceId, proposition)))) as EditorialProposal;
    } catch {
      proposal = null;
    }
  }
  const website = canEdit ? (await getOnboarding(db, userId, workspaceId)).company.website : null;
  const field = {
    positioning: proposal?.positioning ?? line.positioning ?? '',
    offers: proposal?.offers ?? line.offers ?? '',
    audiences: proposal?.audiences ?? line.audiences ?? '',
    allowedProofs: proposal?.allowedProofs ?? line.allowedProofs ?? '',
    tone: proposal?.tone ?? line.tone ?? '',
    bannedPhrases: (proposal?.bannedPhrases ?? line.bannedPhrases).join('\n'),
  };

  return (
    <>
      <h1>Ligne éditoriale</h1>
      <Flash code={message} />
      <p className="hint">
        L’IA rédige à partir de ces informations. Elle ne cite que ce qui figure ici et dans l’état de l’offre : rien n’est inventé, ce qui manque est
        signalé par un marqueur [À COMPLÉTER] qui bloque la publication.
      </p>

      {canEdit && (
        <details className="assist" id="proposer" open={line.version === 0 && proposal === null}>
          <summary>Proposer avec l’IA, à partir du site et de posts publiés</summary>
          <form action={proposeLineAction.bind(null, workspaceId)} className="stack">
            <p className="hint">L’IA lit la page d’accueil du site et les posts collés, puis pré-remplit le formulaire ci-dessous. Vous relisez, corrigez, puis enregistrez : rien n’est enregistré avant.</p>
            <label htmlFor="site">Site de l’entreprise</label>
            <input id="site" name="site" type="text" inputMode="url" defaultValue={website ?? ''} placeholder="www.exemple.fr" maxLength={300} />
            <label htmlFor="posts">Quelques posts déjà publiés (facultatif), séparés par une ligne « --- »</label>
            <textarea id="posts" name="posts" rows={6} maxLength={16000} />
            <button type="submit">Proposer la ligne éditoriale</button>
          </form>
        </details>
      )}

      <section aria-labelledby="ligne-titre" id="ligne">
        <h2 id="ligne-titre">
          Ligne en vigueur {line.version > 0 && <small>· version {line.version}</small>}
        </h2>
        {proposal !== null && (
          <div className="flash success" role="status">
            <p>
              <strong>Proposition de l’IA, à relire.</strong> Le formulaire est pré-rempli{proposal.sourceUrl ? ` à partir de ${proposal.sourceUrl}` : ' à partir des posts collés'} : corrigez-le, puis
              enregistrez. Rien n’est enregistré avant.
            </p>
            {proposal.websiteError && <p>{proposal.websiteError}</p>}
            {proposal.toVerify.length > 0 && (
              <>
                <p>À préciser :</p>
                <ul>
                  {proposal.toVerify.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
            {proposal.suspiciousInstructions.length > 0 && (
              <p>Consignes trouvées dans les contenus lus, et ignorées : {proposal.suspiciousInstructions.map((s) => `« ${s} »`).join(', ')}.</p>
            )}
          </div>
        )}
        <form key={proposal === null ? 'ligne' : `proposition-${String(proposition)}`} action={saveLineAction.bind(null, workspaceId)} className="stack">
          <fieldset disabled={readOnly}>
            <legend>Ce que l’entreprise dit d’elle</legend>
            <div className="stack">
              <label htmlFor="positionnement">Positionnement</label>
              <textarea id="positionnement" name="positionnement" rows={3} defaultValue={field.positioning} />
              <label htmlFor="offres">Offres (présentation générale)</label>
              <textarea id="offres" name="offres" rows={3} defaultValue={field.offers} />
              <label htmlFor="cibles">Cibles</label>
              <textarea id="cibles" name="cibles" rows={2} defaultValue={field.audiences} />
              <label htmlFor="preuves">Preuves autorisées</label>
              <textarea id="preuves" name="preuves" rows={3} defaultValue={field.allowedProofs} aria-describedby="preuves-aide" />
              <p id="preuves-aide" className="hint">
                Chiffres, références clients (avec leur accord), labels : seules ces preuves peuvent être citées.
              </p>
              <label htmlFor="ton">Ton</label>
              <textarea id="ton" name="ton" rows={2} defaultValue={field.tone} />
              <label htmlFor="interdits">Mots et formules interdits (un par ligne)</label>
              <textarea id="interdits" name="interdits" rows={3} defaultValue={field.bannedPhrases} />
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

      <section aria-labelledby="sources-titre" id="sources">
        <h2 id="sources-titre">Sources de veille</h2>
        <p className="hint">
          Flux RSS ou Atom (blog de l’entreprise, veille réglementaire…) relevés chaque heure. Quand le planning ne remplit pas une semaine, l’IA
          peut tirer un post d’un article récent, en citant son lien. Le contenu des articles n’est jamais pris pour une consigne.
        </p>
        {sources.sources.length === 0 && <p className="muted">Aucune source suivie.</p>}
        <ul className="cards">
          {sources.sources.map((source) => (
            <li key={source.id} className="card">
              <p>
                <strong>{source.label}</strong> {!source.enabled && <span className="badge">Suspendue</span>}
              </p>
              <p className="muted pre">{source.url}</p>
              <p className="muted">
                {source.lastFetchedAt ? `Relevée le ${dateFormat.format(source.lastFetchedAt)}` : 'Pas encore relevée'} · {source.articles} article
                {source.articles > 1 ? 's' : ''}, dont {source.unused} disponible{source.unused > 1 ? 's' : ''}
              </p>
              {source.lastError && <p className="flash error">Dernière relève : {source.lastError}</p>}
              {sources.canEdit && (
                <div className="actions">
                  <form action={toggleSourceAction.bind(null, workspaceId, source.id, !source.enabled)}>
                    <button type="submit">{source.enabled ? 'Suspendre' : 'Reprendre'}</button>
                  </form>
                  <form action={deleteSourceAction.bind(null, workspaceId, source.id)}>
                    <button type="submit">Supprimer</button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
        {sources.canEdit && (
          <details open={sources.sources.length === 0}>
            <summary>Ajouter une source</summary>
            <form action={addSourceAction.bind(null, workspaceId)} className="stack">
              <label htmlFor="adresse">Adresse du flux</label>
              <input id="adresse" name="adresse" type="url" required maxLength={1000} placeholder="https://www.exemple.fr/rss.xml" />
              <label htmlFor="libelle">Nom de la source</label>
              <input id="libelle" name="libelle" maxLength={200} />
              <button type="submit" className="primary">
                Suivre cette source
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

import { type EditorialProposal, NotFoundError, type OfferItem, editorialHistory, getEditorialLine, getOnboarding, listOffer, listSources } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { PageHeader } from '../../../../components/page-header.tsx';
import { database, mediaStore } from '../../../../server/context.ts';
import { editorialProposalKey } from '../../../../server/drafts.ts';
import { requireUserId } from '../../../../server/session.ts';
import { addSourceAction, deleteOfferAction, deleteSourceAction, proposeLineAction, saveLineAction, saveOfferAction, toggleSourceAction } from '../actions.ts';
import styles from './ligne.module.css';
import { PublishedPostsField } from './published-posts-field.tsx';

export const metadata: Metadata = { title: 'Ligne éditoriale' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVAILABILITY: Record<OfferItem['status'], string> = {
  available: 'Disponible',
  planned: 'En préparation (jamais présentée comme disponible)',
  retired: 'Retirée',
};
const PRICING: Record<string, string> = { free: 'Gratuite', paid: 'Payante', '': 'Non précisé' };
const EMOJIS: Record<string, string> = { none: 'sans emoji', rare: '2 emojis au plus', free: 'emojis libres' };

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

/** EDI-01, EDI-02, EDI-03, EDI-07 : ligne éditoriale en résumé, règles communes, état de l'offre, historique. */
export default async function EditorialLinePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message, proposition, depuis, modifier, proposer, offre } = await searchParams;
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
  const sections = [
    { key: 'qui', name: 'positionnement', title: 'Qui vous êtes', value: proposal?.positioning ?? line.positioning ?? '', rows: 3 },
    { key: 'offres', name: 'offres', title: 'Ce que vous proposez', value: proposal?.offers ?? line.offers ?? '', rows: 3 },
    { key: 'cibles', name: 'cibles', title: 'À qui vous parlez', value: proposal?.audiences ?? line.audiences ?? '', rows: 2 },
    {
      key: 'preuves',
      name: 'preuves',
      title: 'Ce que vous pouvez affirmer',
      value: proposal?.allowedProofs ?? line.allowedProofs ?? '',
      rows: 3,
      hint: 'Chiffres, références clients (avec leur accord), labels : seules ces preuves peuvent être citées.',
    },
    { key: 'ton', name: 'ton', title: 'Votre ton', value: proposal?.tone ?? line.tone ?? '', rows: 2 },
    { key: 'interdits', name: 'interdits', title: 'À ne jamais écrire', value: (proposal?.bannedPhrases ?? line.bannedPhrases).join('\n'), rows: 3, hint: 'Un mot ou une formule par ligne.' },
  ];

  // Tout s'ouvre pour une première saisie, une proposition à relire ou l'étape du démarrage ; sinon, un seul champ à la fois.
  const editAll = canEdit && (line.version === 0 || proposal !== null || depuis === 'demarrage' || modifier === 'tout');
  const isEditing = (key: string) => canEdit && (editAll || modifier === key);
  const anyEditing = editAll || isEditing('format') || sections.some((section) => isEditing(section.key));
  const editHref = (key: string) => `/ligne/${workspaceId}?modifier=${key}#champ-${key}`;
  const showProposer = canEdit && proposal === null && (proposer === '1' || line.version === 0);
  const { rules } = line;
  const formatSummary = [
    `${rules.minLength} à ${rules.maxLength} caractères`,
    rules.maxHashtags === 0 ? 'sans hashtag' : `${rules.maxHashtags} hashtag${rules.maxHashtags > 1 ? 's' : ''} au plus`,
    EMOJIS[rules.emojis] ?? rules.emojis,
    ...(rules.linksAtEnd ? ['liens en fin de texte'] : []),
    ...(rules.askQuestion ? ['une question au lecteur'] : []),
  ].join(', ');
  const addingOffer = offer.canEdit && (offre === 'nouvelle' || offer.items.length === 0);

  const rows = (
    <div className={styles.summary}>
      {sections.map((section) => (
        <div key={section.key} id={`champ-${section.key}`} className={`${styles.row} ${isEditing(section.key) ? styles.rowEditing : ''}`}>
          {isEditing(section.key) ? (
            <div className="stack">
              <label htmlFor={section.name}>{section.title}</label>
              <textarea id={section.name} name={section.name} rows={section.rows} defaultValue={section.value} {...(section.hint ? { 'aria-describedby': `${section.name}-aide` } : {})} />
              {section.hint && (
                <p id={`${section.name}-aide`} className="hint">
                  {section.hint}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className={styles.text}>
                <h2 className={styles.title}>{section.title}</h2>
                <p className={styles.value}>{section.value === '' ? <span className="muted">À compléter</span> : section.value}</p>
              </div>
              {canEdit && (
                <>
                  <Link href={editHref(section.key)} className={styles.edit} aria-label={`Modifier : ${section.title}`}>
                    Modifier
                  </Link>
                  <input type="hidden" name={section.name} value={section.value} />
                </>
              )}
            </>
          )}
        </div>
      ))}
      <div id="champ-format" className={`${styles.row} ${isEditing('format') ? styles.rowEditing : ''}`}>
        {isEditing('format') ? (
          <fieldset>
            <legend>Format des posts</legend>
            <div className="stack">
              <label htmlFor="hashtags">Hashtags au plus</label>
              <input id="hashtags" name="hashtags" type="number" min={0} max={30} defaultValue={rules.maxHashtags} />
              <label htmlFor="emojis">Emojis</label>
              <select id="emojis" name="emojis" defaultValue={rules.emojis}>
                <option value="none">Aucun</option>
                <option value="rare">Rares (2 au plus)</option>
                <option value="free">Libres</option>
              </select>
              <label htmlFor="longueur-min">Longueur minimale (caractères)</label>
              <input id="longueur-min" name="longueur-min" type="number" min={0} max={3000} defaultValue={rules.minLength} />
              <label htmlFor="longueur-max">Longueur maximale (caractères)</label>
              <input id="longueur-max" name="longueur-max" type="number" min={1} max={3000} defaultValue={rules.maxLength} />
              <label className="check">
                <input type="checkbox" name="liens-en-fin" defaultChecked={rules.linksAtEnd} /> Liens en fin de texte
              </label>
              <label className="check">
                <input type="checkbox" name="question" defaultChecked={rules.askQuestion} /> Une question posée au lecteur
              </label>
              <p className="hint">Pas de mention @ pour l’instant ; l’accroche doit tenir dans les 2 premières lignes.</p>
            </div>
          </fieldset>
        ) : (
          <>
            <div className={styles.text}>
              <h2 className={styles.title}>Format des posts</h2>
              <p className={styles.value}>{formatSummary}</p>
            </div>
            {canEdit && (
              <>
                <Link href={editHref('format')} className={styles.edit} aria-label="Modifier : Format des posts">
                  Modifier
                </Link>
                <input type="hidden" name="hashtags" value={rules.maxHashtags} />
                <input type="hidden" name="emojis" value={rules.emojis} />
                <input type="hidden" name="longueur-min" value={rules.minLength} />
                <input type="hidden" name="longueur-max" value={rules.maxLength} />
                {rules.linksAtEnd && <input type="hidden" name="liens-en-fin" value="on" />}
                {rules.askQuestion && <input type="hidden" name="question" value="on" />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Ligne éditoriale"
        description="Ce que l’IA sait de vous pour écrire vos posts. Elle n’invente rien : ce qui manque lui est signalé."
        action={
          canEdit && line.version > 0 ? (
            <Link href={`/ligne/${workspaceId}?proposer=1#proposer`} className="button">
              Proposer avec l’IA
            </Link>
          ) : undefined
        }
        {...(canEdit && line.version > 0 ? { menu: [{ label: 'Tout modifier', href: `/ligne/${workspaceId}?modifier=tout#ligne` }] } : {})}
      />
      <Flash code={message} />

      {showProposer && (
        <section className="card" id="proposer" aria-labelledby="proposer-titre">
          <h2 id="proposer-titre">Proposer avec l’IA</h2>
          <form action={proposeLineAction.bind(null, workspaceId)} className="stack">
            <p className="hint">L’IA lit la page d’accueil du site et les posts ajoutés, puis pré-remplit la ligne éditoriale. Vous relisez, corrigez, puis enregistrez : rien n’est enregistré avant.</p>
            <label htmlFor="site">Site de l’entreprise</label>
            <input id="site" name="site" type="text" inputMode="url" defaultValue={website ?? ''} placeholder="www.exemple.fr" maxLength={300} />
            <PublishedPostsField />
            <button type="submit" className="primary">
              Proposer la ligne éditoriale
            </button>
          </form>
        </section>
      )}

      <section aria-label="Ligne en vigueur" id="ligne">
        {proposal !== null && (
          <div className="flash success" role="status">
            <p>
              <strong>Proposition de l’IA, à relire.</strong> Le formulaire est pré-rempli{proposal.sourceUrl ? ` à partir de ${proposal.sourceUrl}` : ' à partir de vos posts'} : corrigez-le, puis
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
        {canEdit ? (
          <form key={proposal === null ? `ligne-${String(modifier)}` : `proposition-${String(proposition)}`} action={saveLineAction.bind(null, workspaceId)}>
            {depuis === 'demarrage' && <input type="hidden" name="depuis" value="demarrage" />}
            {rows}
            {anyEditing && (
              <div className={styles.saveBar}>
                <button type="submit" className="primary">
                  Enregistrer une nouvelle version
                </button>
                {line.version > 0 && <Link href={`/ligne/${workspaceId}`}>Annuler</Link>}
              </div>
            )}
          </form>
        ) : (
          rows
        )}
      </section>

      <section aria-labelledby="offre-titre" id="offre">
        <div className={styles.head}>
          <h2 id="offre-titre">Vos offres</h2>
          {offer.canEdit && offer.items.length > 0 && (
            <Link href={`/ligne/${workspaceId}?offre=nouvelle#offre`} className="button">
              Ajouter une offre
            </Link>
          )}
        </div>
        <p className="hint">L’IA ne présente comme disponible que ce qui est marqué « Disponible ».</p>
        {offer.items.length === 0 && !offer.canEdit && <p className="muted">Aucune offre renseignée.</p>}
        {offer.items.length > 0 && (
          <div className={styles.summary}>
            {offer.items.map((item) =>
              offer.canEdit && offre === item.id ? (
                <div key={item.id} className={`${styles.row} ${styles.rowEditing}`}>
                  <form action={saveOfferAction.bind(null, workspaceId, item.id)} className="stack">
                    <OfferFields item={item} />
                    <button type="submit">Enregistrer</button>
                  </form>
                  <div className={styles.saveBar}>
                    <form action={deleteOfferAction.bind(null, workspaceId, item.id)}>
                      <button type="submit">Supprimer</button>
                    </form>
                    <Link href={`/ligne/${workspaceId}#offre`}>Annuler</Link>
                  </div>
                </div>
              ) : (
                <div key={item.id} className={styles.row}>
                  <div className={styles.text}>
                    <p className={styles.value}>
                      <strong>{item.name}</strong>
                    </p>
                    <p className="muted">
                      {AVAILABILITY[item.status].split(' (')[0]} · {PRICING[item.pricing ?? '']}
                    </p>
                    {item.description && <p className="muted">{item.description}</p>}
                  </div>
                  {offer.canEdit && (
                    <Link href={`/ligne/${workspaceId}?offre=${item.id}#offre`} className={styles.edit} aria-label={`Modifier : ${item.name}`}>
                      Modifier
                    </Link>
                  )}
                </div>
              ),
            )}
          </div>
        )}
        {addingOffer && (
          <div className="card">
            <form action={saveOfferAction.bind(null, workspaceId, null)} className="stack">
              <OfferFields />
              <button type="submit" className="primary">
                Ajouter
              </button>
            </form>
            {offer.items.length > 0 && (
              <p>
                <Link href={`/ligne/${workspaceId}#offre`}>Annuler</Link>
              </p>
            )}
          </div>
        )}
      </section>

      <div className={styles.foot}>
        <details id="sources" open={typeof message === 'string' && message.startsWith('source')}>
          <summary>Sources de veille ({sources.sources.length})</summary>
          <p className="hint">
            Flux RSS ou Atom (blog de l’entreprise, veille réglementaire…) relevés chaque heure. Quand le planning ne remplit pas une semaine, l’IA peut tirer un post d’un article récent, en citant son
            lien. Le contenu des articles n’est jamais pris pour une consigne.
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
            <form action={addSourceAction.bind(null, workspaceId)} className="stack">
              <label htmlFor="adresse">Adresse du flux</label>
              <input id="adresse" name="adresse" type="url" required maxLength={1000} placeholder="https://www.exemple.fr/rss.xml" />
              <label htmlFor="libelle">Nom de la source</label>
              <input id="libelle" name="libelle" maxLength={200} />
              <button type="submit">Suivre cette source</button>
            </form>
          )}
        </details>

        {history.length > 0 && (
          <details>
            <summary>Historique des versions ({history.length})</summary>
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
          </details>
        )}
        {line.savedAt && (
          <p className="muted">
            Version {line.version}, modifiée le {dateFormat.format(line.savedAt)}
            {line.savedBy && ` par ${line.savedBy}`}.
          </p>
        )}
      </div>
    </>
  );
}

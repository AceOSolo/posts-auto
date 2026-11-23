import { type Idea, type IdeaStatus, NotFoundError, inboundConfigFromEnv, inboundEmailSettings, listIdeas, listWorkspaceAccounts } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { StatusBadge } from '../../../../components/status-badge.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { disableInboundAddressAction, ideaStatusAction, renewInboundAddressAction, repurposeAction, saveIdeaAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Idées' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWS: Record<string, { label: string; statuses: IdeaStatus[] }> = {
  ouvertes: { label: 'Nouvelles et retenues', statuses: ['new', 'kept'] },
  utilisees: { label: 'Utilisées', statuses: ['used'] },
  ecartees: { label: 'Écartées', statuses: ['dismissed'] },
};
const STATUS: Record<IdeaStatus, string> = { new: 'Nouvelle', kept: 'Retenue', used: 'Utilisée', dismissed: 'Écartée' };
const day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmt = (date: string) => day.format(new Date(`${date}T00:00:00Z`));

function IdeaFields({ idea, accounts }: { idea?: Idea; accounts: readonly { id: string; name: string }[] }) {
  const p = idea?.id ?? 'nouvelle';
  return (
    <>
      <label htmlFor={`titre-${p}`}>Idée</label>
      <input id={`titre-${p}`} name="titre" required maxLength={300} defaultValue={idea?.title ?? ''} />
      <label htmlFor={`details-${p}`}>Détails (ce qu’il faut savoir pour écrire)</label>
      <textarea id={`details-${p}`} name="details" rows={3} maxLength={4000} defaultValue={idea?.details ?? ''} />
      <label htmlFor={`lien-${p}`}>Lien</label>
      <input id={`lien-${p}`} name="lien" type="url" maxLength={1000} defaultValue={idea?.link ?? ''} />
      <div className="inline-fields">
        <div>
          <label htmlFor={`debut-${p}`}>Pertinente à partir du</label>
          <input id={`debut-${p}`} name="debut" type="date" defaultValue={idea?.startsOn ?? ''} />
        </div>
        <div>
          <label htmlFor={`fin-${p}`}>jusqu’au</label>
          <input id={`fin-${p}`} name="fin" type="date" defaultValue={idea?.endsOn ?? ''} />
        </div>
      </div>
      <label htmlFor={`evenement-${p}`}>Date de l’événement lié (le post partira avant)</label>
      <input id={`evenement-${p}`} name="evenement" type="date" defaultValue={idea?.eventOn ?? ''} />
      <fieldset>
        <legend>Comptes visés (aucun coché : tous)</legend>
        {accounts.map((a) => (
          <label key={a.id} className="check">
            <input type="checkbox" name="comptes" value={a.id} defaultChecked={idea?.accountIds.includes(a.id) ?? false} /> {a.name}
          </label>
        ))}
      </fieldset>
    </>
  );
}

/** IDE-01, IDE-02 : idées de l'équipe et réserve de l'IA, avec leur suivi. */
export default async function IdeasPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message, vue } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const view = typeof vue === 'string' && vue in VIEWS ? vue : 'ouvertes';
  let data;
  try {
    data = await Promise.all([
      listIdeas(database(), userId, workspaceId, VIEWS[view]?.statuses),
      listWorkspaceAccounts(database(), userId, workspaceId),
      inboundEmailSettings(database(), userId, workspaceId, inboundConfigFromEnv(process.env)),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [{ ideas, canPropose, canManage }, accountList, inbound] = data;
  const accounts = accountList.map((a) => ({ id: a.id, name: a.name }));
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));

  return (
    <>
      <h1>Idées</h1>
      <nav aria-label="Idées" className="subnav">
        {Object.entries(VIEWS).map(([key, v]) => (
          <Link key={key} href={`/idees/${workspaceId}?vue=${key}`} aria-current={key === view ? 'page' : undefined}>
            {v.label}
          </Link>
        ))}
        <Link href={`/demandes/${workspaceId}`}>Demandes de post</Link>
      </nav>
      <Flash code={message} />
      <p className="hint">
        Une idée est un sujet à placer quand c’est pertinent : l’IA la reprend lors d’une prochaine rédaction. Pour un post précis à une date
        donnée, faites plutôt une <Link href={`/demandes/${workspaceId}`}>demande de post</Link>.
      </p>

      {canPropose && view === 'ouvertes' && (
        <details open={ideas.length === 0}>
          <summary>Proposer une idée</summary>
          <form action={saveIdeaAction.bind(null, workspaceId, null)} className="stack">
            <IdeaFields accounts={accounts} />
            <button type="submit" className="primary">
              Proposer
            </button>
          </form>
        </details>
      )}

      {canPropose && view === 'ouvertes' && (
        <details>
          <summary>Décliner un article en idées</summary>
          <form action={repurposeAction.bind(null, workspaceId)} className="stack">
            <label htmlFor="article">Adresse d’un article (votre blog, un média, une page de votre site)</label>
            <input id="article" name="article" type="url" inputMode="url" required maxLength={1000} placeholder="https://…" aria-describedby="article-aide" />
            <p id="article-aide" className="hint">
              L’IA lit l’article et en tire trois angles de posts distincts (un conseil, un fait marquant, une question…), ajoutés ici comme idées pour tous les comptes. Elle ne
              s’appuie que sur ce que dit l’article.
            </p>
            <button type="submit">Tirer trois idées de l’article</button>
          </form>
        </details>
      )}

      {inbound.available && view === 'ouvertes' && (inbound.address !== null || inbound.canManage) && (
        <details>
          <summary>Proposer par e-mail</summary>
          <div className="stack">
            {inbound.address !== null ? (
              <>
                <p>
                  Adresse de cet espace : <code>{inbound.address}</code>
                </p>
                <p className="hint">
                  Écrivez depuis l’adresse de votre compte Rostra. L’objet devient le titre et le message les détails. Un objet qui commence par « Demande : » crée une demande de post sur les
                  comptes dont vous êtes titulaire. Gardez cette adresse pour votre équipe : rien n’est publié sans validation.
                </p>
              </>
            ) : (
              <p className="hint">Créez une adresse pour que votre équipe envoie ses idées et ses demandes par e-mail.</p>
            )}
            {inbound.canManage && (
              <div className="actions">
                <form action={renewInboundAddressAction.bind(null, workspaceId)}>
                  <button type="submit">{inbound.address === null ? 'Créer l’adresse' : 'Changer l’adresse'}</button>
                </form>
                {inbound.address !== null && (
                  <form action={disableInboundAddressAction.bind(null, workspaceId)}>
                    <button type="submit">Désactiver</button>
                  </form>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      {ideas.length === 0 && <p className="muted">Aucune idée ici.</p>}
      <ul className="cards">
        {ideas.map((idea) => (
          <li key={idea.id} className="card">
            <p>
              <span className="badge">{idea.origin === 'ai_reserve' ? 'Réserve de l’IA' : STATUS[idea.status]}</span> <strong>{idea.title}</strong>
            </p>
            {idea.details && <p className="pre">{idea.details}</p>}
            <p className="muted">
              {idea.allAccounts ? 'Tous les comptes' : idea.accountIds.map((id) => nameOf.get(id) ?? 'Compte').join(', ')}
              {idea.startsOn && ` · à partir du ${fmt(idea.startsOn)}`}
              {idea.endsOn && ` · jusqu’au ${fmt(idea.endsOn)}`}
              {idea.eventOn && ` · événement le ${fmt(idea.eventOn)}`}
              {idea.authorName && ` · proposée par ${idea.authorName}`}
            </p>
            {idea.link && (
              <p>
                <a href={idea.link} rel="noopener noreferrer" target="_blank">
                  {idea.link}
                </a>
              </p>
            )}
            {idea.followup && <p className="ai-note">Suivi : {idea.followup}</p>}
            {idea.posts.map((post) => (
              <p key={post.id}>
                <Link href={`/posts/${post.id}`}>Post issu de cette idée</Link> <StatusBadge status={post.status} />
              </p>
            ))}
            {idea.status !== 'used' && (
              <div className="actions">
                {canManage && idea.status !== 'kept' && (
                  <form action={ideaStatusAction.bind(null, workspaceId, idea.id, 'kept')}>
                    <button type="submit">Retenir</button>
                  </form>
                )}
                {canManage && idea.status !== 'dismissed' && (
                  <form action={ideaStatusAction.bind(null, workspaceId, idea.id, 'dismissed')}>
                    <button type="submit">Écarter</button>
                  </form>
                )}
                {canManage && idea.status === 'dismissed' && (
                  <form action={ideaStatusAction.bind(null, workspaceId, idea.id, 'new')}>
                    <button type="submit">Remettre parmi les idées</button>
                  </form>
                )}
              </div>
            )}
            {idea.canEdit && idea.status !== 'used' && (
              <details>
                <summary>Modifier</summary>
                <form action={saveIdeaAction.bind(null, workspaceId, idea.id)} className="stack">
                  <IdeaFields idea={idea} accounts={accounts} />
                  <button type="submit">Enregistrer</button>
                </form>
              </details>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

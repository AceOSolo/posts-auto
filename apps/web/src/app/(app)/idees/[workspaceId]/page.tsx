import { type Idea, type IdeaStatus, NotFoundError, inboundConfigFromEnv, inboundEmailSettings, listIdeas, listWorkspaceAccounts } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { PageHeader } from '../../../../components/page-header.tsx';
import { StatusBadge } from '../../../../components/status-badge.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { ideasMenu } from '../../planning/planning-ui.tsx';
import { ideaStatusAction, renewInboundAddressAction, repurposeAction, saveIdeaAction } from '../actions.ts';

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
  const { message, vue, ajouter } = await searchParams;
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
  const hasInboundAddress = inbound.available && inbound.address !== null;

  return (
    <>
      <PageHeader
        title="Idées"
        description="Des sujets à placer quand c’est pertinent : l’IA les reprend à la prochaine rédaction."
        action={
          canPropose ? (
            <Link href={`/idees/${workspaceId}?ajouter=1#proposer`} className="button primary">
              Proposer une idée
            </Link>
          ) : undefined
        }
        menu={ideasMenu(workspaceId)}
      />
      <Flash code={message} />

      {canPropose && view === 'ouvertes' && (
        <section id="proposer" aria-labelledby="proposer-titre" className="card" hidden={ideas.length > 0 && ajouter !== '1'}>
          <h2 id="proposer-titre">Nouvelle idée</h2>
          <form action={saveIdeaAction.bind(null, workspaceId, null)} className="stack">
            <IdeaFields accounts={accounts} />
            <button type="submit" className="primary">
              Proposer
            </button>
          </form>
          {ideas.length > 0 && (
            <p>
              <Link href={`/idees/${workspaceId}`}>Annuler</Link>
            </p>
          )}
        </section>
      )}

      {(canPropose || hasInboundAddress) && view === 'ouvertes' && (
        <details>
          <summary>Autres façons d’ajouter des idées</summary>
          {canPropose && (
            <form action={repurposeAction.bind(null, workspaceId)} className="stack">
              <label htmlFor="article">Décliner un article (votre blog, un média, une page de votre site)</label>
              <input id="article" name="article" type="url" inputMode="url" required maxLength={1000} placeholder="https://…" aria-describedby="article-aide" />
              <p id="article-aide" className="hint">
                L’IA lit l’article et en tire trois angles de posts distincts (un conseil, un fait marquant, une question…), ajoutés ici comme idées pour tous les comptes. Elle ne
                s’appuie que sur ce que dit l’article.
              </p>
              <button type="submit">Tirer trois idées de l’article</button>
            </form>
          )}
          {hasInboundAddress && (
            <div className="stack">
              <h2>Proposer par e-mail</h2>
              <p>
                Écrivez à <code>{inbound.address}</code> depuis l’adresse de votre compte Rostra.
              </p>
              <p className="hint">
                L’objet devient le titre et le message les détails. Un objet qui commence par « Demande : » crée une demande de post sur vos comptes. Gardez cette adresse pour votre équipe : rien
                n’est publié sans validation.
              </p>
              {inbound.canManage && (
                <form action={renewInboundAddressAction.bind(null, workspaceId)}>
                  <button type="submit">Changer l’adresse</button>
                </form>
              )}
            </div>
          )}
        </details>
      )}

      <div role="group" aria-label="Idées affichées" className="segmented">
        {Object.entries(VIEWS).map(([key, v]) => (
          <Link key={key} href={`/idees/${workspaceId}?vue=${key}`} aria-current={key === view ? 'true' : undefined}>
            {v.label}
          </Link>
        ))}
      </div>

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

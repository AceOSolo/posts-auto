import type { PostStatus } from '@posts-auto/core';
import { type PostCard, hasConnectedProfile, listMyPosts, listMyWorkspaces, pendingOnboardings } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Flash } from '../../components/flash.tsx';
import decision from '../../components/post-decision.module.css';
import { PostPreview } from '../../components/post-preview.tsx';
import { StatusBadge } from '../../components/status-badge.tsx';
import { database } from '../../server/context.ts';
import { requireUserId } from '../../server/session.ts';
import { validateAction } from './posts/actions.ts';
import page from './posts/post-page.module.css';

export const metadata: Metadata = { title: 'Mes posts' };
export const dynamic = 'force-dynamic';

const GROUPS: { title: string; statuses: readonly PostStatus[]; empty: string }[] = [
  { title: 'À valider', statuses: ['a_valider'], empty: 'Rien à valider pour le moment.' },
  { title: 'Erreurs de publication', statuses: ['erreur'], empty: '' },
  { title: 'Validés, prêts à partir', statuses: ['valide', 'en_publication'], empty: 'Aucun post validé en attente de départ.' },
  { title: 'En cours de reprise', statuses: ['modif', 'refuse'], empty: '' },
];

/** Un post qui attend une décision : l'aperçu et les trois décisions. */
function Card({ post }: { post: PostCard }) {
  return (
    <li className={`card ${page.listCard}`}>
      <p className="departure">{post.departure}</p>
      <PostPreview accountName={post.accountName} accountKind={post.accountKind} body={post.body} media={post.media} />
      <div className={decision.bar}>
        <form action={validateAction.bind(null, post.id)}>
          <input type="hidden" name="retour" value="liste" />
          <button type="submit" className={`primary ${decision.action} ${decision.validate}`} disabled={post.hasBlockingMarkers}>
            Valider
          </button>
        </form>
        <Link href={`/posts/${post.id}?action=modifier#decision`} className={`button ${decision.action} ${decision.modify}`}>
          Modifier
        </Link>
        <Link href={`/posts/${post.id}?action=refuser#decision`} className={`button ${decision.action} ${decision.refuse}`}>
          Refuser
        </Link>
      </div>
      {post.hasBlockingMarkers && <p className="hint">Ce post contient un passage à compléter avant validation.</p>}
    </li>
  );
}

/** Un post qui ne demande rien pour l'instant : une ligne suffit. */
function Row({ post }: { post: PostCard }) {
  return (
    <li className="card">
      <div className={page.row}>
        <div className={page.rowText}>
          <p>
            <strong>{post.accountName}</strong> <StatusBadge status={post.status} />
          </p>
          <p>{post.departure}</p>
          <p className={page.excerpt}>{post.body}</p>
        </div>
        <Link href={`/posts/${post.id}`} className="button">
          Voir le détail
        </Link>
      </div>
      {post.lastError && <p className="flash error">{post.lastError}</p>}
    </li>
  );
}

/** VAL-01 : l'espace du titulaire, pensé pour le téléphone, trié par heure de départ. */
export default async function MyPostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const userId = await requireUserId();
  const { message } = await searchParams;
  const posts = await listMyPosts(database(), userId, new Date());
  const [workspaces, connected, onboardings] = await Promise.all([listMyWorkspaces(database(), userId), hasConnectedProfile(database(), userId), pendingOnboardings(database(), userId)]);
  const firstWorkspace = workspaces[0];

  return (
    <>
      <h1>Mes posts</h1>
      <Flash code={message} />
      {/* ONB-08 : « prêt à publier » tant que l'assistant de démarrage n'est pas terminé. */}
      {onboardings.map((o) => (
        <p key={o.workspaceId} className="card onboarding-indicator">
          <strong>
            {o.workspaceName} : prêt à publier à {o.doneCount} sur {o.total}
          </strong>
          <progress value={o.doneCount} max={o.total} aria-label={`Démarrage : ${o.doneCount} étapes sur ${o.total}`} />
          <Link href={`/demarrage/${o.workspaceId}`}>Continuer le démarrage</Link>
        </p>
      ))}
      {!connected && firstWorkspace && (
        <p className="card">
          Pour que des posts puissent partir sur votre profil, connectez-le à LinkedIn (une minute, une seule fois).{' '}
          <Link href={`/comptes/${firstWorkspace.id}/connecter`}>Connecter mon profil LinkedIn</Link>
        </p>
      )}
      {GROUPS.map((group) => {
        const items = posts.filter((post) => group.statuses.includes(post.status));
        if (items.length === 0 && group.empty === '') return null;
        return (
          <section key={group.title} aria-labelledby={`g-${group.statuses[0]}`}>
            <div className={page.groupHead}>
              <h2 id={`g-${group.statuses[0]}`}>
                {group.title} <span className="count">{items.length}</span>
              </h2>
              {group.statuses[0] === 'a_valider' && items.length > 1 && (
                <Link href={`/posts/${items[0]?.id}`} className="button">
                  Les traiter un par un
                </Link>
              )}
            </div>
            {items.length === 0 ? (
              <p className="muted">{group.empty}</p>
            ) : (
              <ul className="cards">
                {items.map((post) => (post.status === 'a_valider' ? <Card key={post.id} post={post} /> : <Row key={post.id} post={post} />))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}

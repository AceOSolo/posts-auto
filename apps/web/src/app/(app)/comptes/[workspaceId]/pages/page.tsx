import { ForbiddenError, NotFoundError, pendingPageConnection } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { confirmPagesAction } from '../../actions.ts';

export const metadata: Metadata = { title: 'Pages d’entreprise' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** LNK-02 : choix des pages à ajouter parmi celles que la personne administre sur LinkedIn. */
export default async function ChoosePagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { attente, message } = await searchParams;
  if (!UUID.test(workspaceId) || typeof attente !== 'string' || !UUID.test(attente)) notFound();
  const userId = await requireUserId();
  let choices;
  try {
    choices = await pendingPageConnection(database(), userId, workspaceId, attente, new Date());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) redirect(`/comptes/${workspaceId}?message=interdit`);
    throw error;
  }
  if (choices === null) redirect(`/comptes/${workspaceId}?message=connexion-expiree`);

  return (
    <>
      <p>
        <Link href={`/comptes/${workspaceId}`}>← Comptes</Link>
      </p>
      <h1>Pages d’entreprise à ajouter</h1>
      <Flash code={message} />
      <p className="hint">
        Voici les pages que vous administrez sur LinkedIn. Cochez celles dont les posts seront préparés et publiés ici. Les validateurs de chaque page se règlent ensuite
        dans les réglages de l’espace.
      </p>
      <form action={confirmPagesAction.bind(null, workspaceId, attente)} className="stack">
        <fieldset className="choices">
          <legend>Pages</legend>
          {choices.map((page) => (
            <label key={page.urn}>
              <input type="checkbox" name="pages" value={page.urn} defaultChecked={page.inWorkspace} disabled={page.elsewhere} /> {page.name}
              {page.inWorkspace && ' (déjà ici : la connexion sera renouvelée)'}
              {page.elsewhere && ' (déjà connectée dans un autre espace)'}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="primary">
          Ajouter les pages cochées
        </button>
      </form>
      <p className="hint">Ce choix reste possible 15 minutes ; au-delà, reconnectez-vous à LinkedIn.</p>
    </>
  );
}

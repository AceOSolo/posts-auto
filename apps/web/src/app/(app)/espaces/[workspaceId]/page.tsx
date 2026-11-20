import { ForbiddenError, NotFoundError, WORKSPACE_NAME_MAX, listOrgWorkspaces } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { createWorkspaceAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Espaces' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Espaces de l'organisation ; pour une agence, un espace par client (section 3.1). */
export default async function WorkspacesPage({
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
  let data;
  try {
    data = await listOrgWorkspaces(database(), userId, workspaceId);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }
  const agency = data.orgKind === 'agence';

  return (
    <>
      <h1>
        {agency ? 'Clients' : 'Espaces'} · {data.orgName}
      </h1>
      <Flash code={message} />
      <p className="hint">
        {agency
          ? 'Chaque client a son espace : sa ligne éditoriale, ses comptes LinkedIn, son planning et son équipe. Une personne invitée dans l’espace d’un client ne voit que celui-ci. La facturation est celle de l’agence, tous clients confondus.'
          : 'Chaque espace a sa ligne éditoriale, ses comptes LinkedIn, son planning et son équipe.'}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{agency ? 'Client' : 'Espace'}</th>
              <th scope="col">Comptes actifs</th>
              <th scope="col">Personnes</th>
              <th scope="col">À valider</th>
              <th scope="col">Démarrage</th>
            </tr>
          </thead>
          <tbody>
            {data.workspaces.map((w) => (
              <tr key={w.id}>
                <th scope="row">
                  <Link href={`/tableau/${w.id}`}>{w.name}</Link>
                </th>
                <td>{w.accounts}</td>
                <td>{w.members}</td>
                <td>{w.pendingValidation}</td>
                <td>{w.onboarded ? 'terminé' : <Link href={`/demarrage/${w.id}`}>à poursuivre</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section aria-labelledby="nouvel-espace">
        <h2 id="nouvel-espace">{agency ? 'Ajouter un client' : 'Ajouter un espace'}</h2>
        {data.canCreate ? (
          <form action={createWorkspaceAction.bind(null, workspaceId)} className="stack">
            <label>
              Nom {agency ? 'du client' : 'de l’espace'}
              <input name="nom" required maxLength={WORKSPACE_NAME_MAX} autoComplete="organization" />
            </label>
            <button type="submit">{agency ? 'Créer l’espace du client' : 'Créer l’espace'}</button>
          </form>
        ) : (
          <p>
            Votre formule permet {data.maxWorkspaces} espace{(data.maxWorkspaces ?? 0) > 1 ? 's' : ''}. <Link href={`/abonnement/${workspaceId}`}>Voir les formules</Link> (la formule Agence permet des espaces illimités).
          </p>
        )}
      </section>
    </>
  );
}

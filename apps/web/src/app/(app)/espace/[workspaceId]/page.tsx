import { listDelegates, listMembers, listWorkspaceAccounts } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { changeRoleAction, delegatesAction, inviteAction, pauseAction, removeMemberAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Réglages de l’espace' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: Record<string, string> = {
  admin: 'Administrateur',
  editor: 'Éditeur (communication)',
  contributor: 'Contributeur',
  viewer: 'Lecteur',
};

/** Membres (ONB-07), validateurs délégués (ROL-01) et pause des comptes (LNK-07). */
export default async function WorkspaceSettingsPage({
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
  const { members, canManage } = await listMembers(db, userId, workspaceId);
  if (members.length === 0 && !canManage) notFound();
  const accounts = await listWorkspaceAccounts(db, userId, workspaceId);
  const delegates = new Map(await Promise.all(accounts.map(async (account) => [account.id, new Set(await listDelegates(db, userId, account.id))] as const)));

  return (
    <>
      <h1>Réglages de l’espace</h1>
      <Flash code={message} />
      <p>
        <Link href={`/demarrage/${workspaceId}`}>Assistant de démarrage</Link> : entreprise, comptes, ligne éditoriale, charte, créneaux, première rédaction.
      </p>

      <section aria-labelledby="membres">
        <h2 id="membres">Membres</h2>
        <ul className="cards">
          {members.map((member) => (
            <li key={member.userId} className="card">
              <strong>{member.fullName ?? member.email}</strong> <span className="muted">· {member.email}</span>
              <p className="muted">{member.lastLoginAt ? 'S’est déjà connecté' : 'Jamais connecté'}</p>
              {canManage ? (
                <div className="actions">
                  <form action={changeRoleAction.bind(null, workspaceId, member.userId)} className="inline">
                    <label htmlFor={`role-${member.userId}`} className="visually-hidden">
                      Rôle de {member.fullName ?? member.email}
                    </label>
                    <select id={`role-${member.userId}`} name="role" defaultValue={member.role}>
                      {Object.entries(ROLES).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button type="submit">Changer le rôle</button>
                  </form>
                  {member.userId !== userId && (
                    <form action={removeMemberAction.bind(null, workspaceId, member.userId)}>
                      <button type="submit">Retirer de l’espace</button>
                    </form>
                  )}
                </div>
              ) : (
                <p>{ROLES[member.role]}</p>
              )}
            </li>
          ))}
        </ul>

        {canManage && (
          <details open={members.length <= 1}>
            <summary>Inviter une personne</summary>
            <form action={inviteAction.bind(null, workspaceId)} className="stack">
              <label htmlFor="invite-email">Adresse e-mail</label>
              <input id="invite-email" name="email" type="email" required autoComplete="off" />
              <label htmlFor="invite-nom">Nom (facultatif)</label>
              <input id="invite-nom" name="nom" type="text" autoComplete="off" />
              <label htmlFor="invite-role">Rôle</label>
              <select id="invite-role" name="role" defaultValue="contributor">
                {Object.entries(ROLES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="hint">La personne reçoit un lien de connexion. Pour publier sur son profil, elle le connecte elle-même ensuite (page Comptes).</p>
              <button type="submit" className="primary">
                Envoyer l’invitation
              </button>
            </form>
          </details>
        )}
      </section>

      <section aria-labelledby="comptes">
        <h2 id="comptes">Comptes LinkedIn : qui peut valider</h2>
        {accounts.length === 0 && <p className="muted">Aucun compte connecté.</p>}
        <ul className="cards">
          {accounts.map((account) => (
            <li key={account.id} className="card">
              <strong>{account.name}</strong> <span className="muted">· titulaire : {account.holderName ?? 'aucun'}</span>
              {account.status === 'paused' && <p className="badge status-erreur">En pause : rien ne part</p>}
              {canManage && (
                <>
                  <form action={delegatesAction.bind(null, workspaceId, account.id)} className="stack">
                    <fieldset>
                      <legend>Peuvent valider à la place du titulaire</legend>
                      {members
                        .filter((member) => member.userId !== account.holderUserId)
                        .map((member) => (
                          <label key={member.userId} className="check">
                            <input type="checkbox" name="delegue" value={member.userId} defaultChecked={delegates.get(account.id)?.has(member.userId) ?? false} />{' '}
                            {member.fullName ?? member.email}
                          </label>
                        ))}
                    </fieldset>
                    <button type="submit">Enregistrer les délégués</button>
                  </form>
                  <form action={pauseAction.bind(null, workspaceId, account.id)}>
                    <input type="hidden" name="pause" value={account.status === 'paused' ? 'non' : 'oui'} />
                    <button type="submit">{account.status === 'paused' ? 'Reprendre les publications' : 'Mettre en pause (rien ne part)'}</button>
                  </form>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

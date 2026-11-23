import { listMembers } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { PageHeader } from '../../../../components/page-header.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { changeRoleAction, inviteAction, removeMemberAction } from '../actions.ts';
import styles from './membres.module.css';

export const metadata: Metadata = { title: 'Membres' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: Record<string, string> = {
  admin: 'Administrateur',
  editor: 'Éditeur (communication)',
  contributor: 'Contributeur',
  viewer: 'Lecteur',
};

/** Membres de l'espace (ONB-07). Validateurs et pause d'un compte : Comptes LinkedIn. Messagerie et support : ./integrations. */
export default async function WorkspaceSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message, inviter, membre } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  const { members, canManage } = await listMembers(database(), userId, workspaceId);
  if (members.length === 0 && !canManage) notFound();
  const inviteOpen = members.length <= 1 || inviter === '1';

  return (
    <>
      <PageHeader
        title="Membres"
        description="Les personnes qui ont accès à cet espace."
        action={
          canManage ? (
            <Link href={`/espace/${workspaceId}?inviter=1#inviter`} className="button primary">
              Inviter une personne
            </Link>
          ) : undefined
        }
      />
      <Flash code={message} />

      {canManage && (
        <section id="inviter" aria-labelledby="inviter-titre" className={`card ${styles.invite}`} hidden={!inviteOpen}>
          <h2 id="inviter-titre">Inviter une personne</h2>
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
            <p className="hint">La personne reçoit un lien de connexion. Pour publier sur son profil, elle le connecte elle-même ensuite.</p>
            <button type="submit" className="primary">
              Envoyer l’invitation
            </button>
          </form>
          {members.length > 1 && (
            <p>
              <Link href={`/espace/${workspaceId}`}>Annuler</Link>
            </p>
          )}
        </section>
      )}

      <ul className={styles.list} aria-label="Membres de l’espace">
        {members.map((member) => {
          const name = member.fullName ?? member.email;
          const editing = canManage && membre === member.userId;
          return (
            <li key={member.userId} id={`membre-${member.userId}`} className={`${styles.row} ${editing ? styles.rowEditing : ''}`}>
              <div className={styles.who}>
                <strong>{name}</strong>
                <p className="muted">
                  {member.fullName !== null && `${member.email} · `}
                  {!editing && `${ROLES[member.role]} · `}
                  {member.lastLoginAt ? 'S’est déjà connecté' : 'Jamais connecté'}
                </p>
              </div>
              {editing ? (
                <>
                  <form action={changeRoleAction.bind(null, workspaceId, member.userId)} className="stack">
                    <label htmlFor={`role-${member.userId}`}>Rôle de {name}</label>
                    <select id={`role-${member.userId}`} name="role" defaultValue={member.role}>
                      {Object.entries(ROLES).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button type="submit">Changer le rôle</button>
                  </form>
                  <div className={styles.editBar}>
                    {member.userId !== userId && (
                      <form action={removeMemberAction.bind(null, workspaceId, member.userId)}>
                        <button type="submit">Retirer de l’espace</button>
                      </form>
                    )}
                    <Link href={`/espace/${workspaceId}`}>Annuler</Link>
                  </div>
                </>
              ) : (
                canManage && (
                  <Link href={`/espace/${workspaceId}?membre=${member.userId}#membre-${member.userId}`} className={styles.edit} aria-label={`Modifier : ${name}`}>
                    Modifier
                  </Link>
                )
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

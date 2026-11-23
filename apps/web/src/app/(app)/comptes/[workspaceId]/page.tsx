import { type AccountSummary, listWorkspaceAccounts } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { autoValidateAction, disconnectAction, publishModeAction, startPagesConnection } from '../actions.ts';
import { AccountAvatar } from './account-avatar.tsx';
import styles from './comptes.module.css';

export const metadata: Metadata = { title: 'Comptes LinkedIn' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, string> = {
  connected: 'Connecté',
  expiring: 'Expire bientôt',
  expired: 'À reconnecter',
  paused: 'En pause',
};
const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });

/** Ce que l'utilisateur doit retenir sur ce compte, en une phrase. */
function accountState(account: AccountSummary): { text: string; tone: 'stateOk' | 'stateWarning' | 'stateError' | 'stateInfo' } {
  if (account.connectionExpiresAt === null || account.status === 'expired') {
    return { text: 'Connexion à renouveler : les posts de ce compte ne partiront pas.', tone: 'stateError' };
  }
  if (account.status === 'paused') return { text: 'Compte en pause : ses posts ne partent pas.', tone: 'stateWarning' };
  if (account.status === 'expiring') {
    return { text: `La connexion expire le ${dateFormat.format(account.connectionExpiresAt)} : reconnectez ce compte pour que ses posts continuent de partir.`, tone: 'stateWarning' };
  }
  if (account.publishMode === 'manual') {
    return { text: 'En pause : plus rien ne part tout seul. Au créneau, le post validé est envoyé par e-mail au titulaire.', tone: 'stateWarning' };
  }
  if (account.publishMode === 'webhook') {
    return { text: `Publication par un ancien scénario (${account.webhookHost ?? 'webhook'}). Reprenez la publication dans les options.`, tone: 'stateInfo' };
  }
  if (account.autoValidate) {
    return { text: 'Pilote automatique : les posts partent sans validation. Seuls ceux qui méritent une relecture restent à valider.', tone: 'stateOk' };
  }
  return { text: 'Tout est en place : vos posts validés partent automatiquement au bon créneau.', tone: 'stateOk' };
}

/** LNK-03 : comptes de l'espace et état de leur connexion. */
export default async function AccountsPage({
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
  const accounts = await listWorkspaceAccounts(database(), userId, workspaceId);
  const hasMine = accounts.some((account) => account.isMine && account.kind === 'profile');

  return (
    <>
      <h1>Comptes LinkedIn</h1>
      <Flash code={message} />
      <div className="actions">
        {!hasMine && (
          <Link href={`/comptes/${workspaceId}/connecter`} className="button primary">
            Connecter mon profil LinkedIn
          </Link>
        )}
        {/* LNK-02 : une personne qui administre les pages sur LinkedIn les ajoute en une fois. */}
        <form action={startPagesConnection.bind(null, workspaceId)}>
          <button type="submit">Connecter des pages d’entreprise</button>
        </form>
      </div>
      {accounts.length === 0 ? (
        <p className="muted">Aucun compte connecté dans cet espace.</p>
      ) : (
        <ul className={`cards ${styles.list}`}>
          {accounts.map((account) => {
            const state = accountState(account);
            const canReconnect = account.isMine && account.kind === 'profile';
            const needsReconnect = account.status === 'expired' || account.status === 'expiring' || account.connectionExpiresAt === null;
            return (
              <li key={account.id} className={`card ${styles.account}`}>
                <div className={styles.identity}>
                  <AccountAvatar name={account.name} src={account.avatarUrl} kind={account.kind} />
                  <div className={styles.who}>
                    <h2 className={styles.name}>{account.name}</h2>
                    <p className={styles.meta}>
                      {account.kind === 'page' ? 'Page LinkedIn' : 'Profil LinkedIn'}
                      {!account.isMine && account.holderName ? ` · ${account.holderName}` : ''}
                    </p>
                    {account.publishMode === 'manual' ? (
                      <span className="badge status-a_valider">En pause</span>
                    ) : (
                      <span className={`badge ${account.status === 'connected' ? 'status-publie' : 'status-erreur'}`}>{STATUS[account.status] ?? account.status}</span>
                    )}
                  </div>
                </div>
                <p className={`${styles.state} ${styles[state.tone]}`}>{state.text}</p>
                {canReconnect && needsReconnect && (
                  <Link href={`/comptes/${workspaceId}/connecter`} className="button primary">
                    Reconnecter mon profil
                  </Link>
                )}
                {/* VAL-11 : le titulaire seul peut publier sans validation, sur son propre compte. */}
                {account.isMine &&
                  account.publishMode === 'auto' &&
                  (account.autoValidate ? (
                    <form action={autoValidateAction.bind(null, workspaceId, account.id)}>
                      <input type="hidden" name="actif" value="non" />
                      <button type="submit" className={styles.autoOff}>
                        Revoir mes posts avant publication
                      </button>
                    </form>
                  ) : (
                    <details className={styles.autoOption}>
                      <summary>Publier sans me demander</summary>
                      <form action={autoValidateAction.bind(null, workspaceId, account.id)} className={styles.autoForm}>
                        <input type="hidden" name="actif" value="oui" />
                        <p>
                          Vos posts partiront en votre nom, sans relecture. Restent à valider : les passages à compléter, les sujets tirés d’un article, d’une idée ou d’une demande, et
                          les posts que vous avez retouchés.
                        </p>
                        <label className="check">
                          <input type="checkbox" name="accord" value="oui" required /> J’accepte que mes posts soient publiés sans ma validation. Je reste responsable de leur contenu.
                        </label>
                        <button type="submit" className="primary">
                          Activer
                        </button>
                      </form>
                    </details>
                  ))}
                <div className={styles.footer}>
                  <Link href={`/comptes/${workspaceId}/fiche/${account.id}`}>Personnaliser la voix et le rythme</Link>
                </div>
                <details className={styles.options} open={account.publishMode !== 'auto'}>
                  <summary>Options</summary>
                  <div className={styles.optionsBody}>
                    <p className="muted">
                      {account.connectionExpiresAt ? `Connexion valable jusqu’au ${dateFormat.format(account.connectionExpiresAt)}.` : 'Aucune connexion active.'}
                    </p>
                    {canReconnect && !needsReconnect && <Link href={`/comptes/${workspaceId}/connecter`}>Reconnecter mon profil</Link>}
                    {/* PUB-09 : en pause, le post validé est envoyé par e-mail au titulaire au créneau. */}
                    {account.canDisconnect && (
                      <form action={publishModeAction.bind(null, workspaceId, account.id)}>
                        <input type="hidden" name="mode" value={account.publishMode === 'auto' ? 'manual' : 'auto'} />
                        <button type="submit">{account.publishMode === 'auto' ? 'Mettre en pause' : 'Reprendre la publication'}</button>
                      </form>
                    )}
                    {account.canDisconnect && (
                      <details>
                        <summary>Déconnecter ce compte</summary>
                        <p className="hint">Les posts validés de ce compte repasseront « à valider ». Ses données de connexion seront supprimées.</p>
                        <form action={disconnectAction.bind(null, workspaceId, account.id)}>
                          <button type="submit">Confirmer la déconnexion</button>
                        </form>
                      </details>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

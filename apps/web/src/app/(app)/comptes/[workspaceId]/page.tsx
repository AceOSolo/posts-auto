import { listWorkspaceAccounts } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { cookies } from 'next/headers';
import { database, tokenCipher } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { disconnectAction, publishModeAction, startPagesConnection, webhookAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Comptes LinkedIn' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, string> = {
  connected: 'Connecté',
  expiring: 'Expire bientôt',
  expired: 'Expiré : à reconnecter',
  paused: 'En pause',
};

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
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });

  // LNK-08 : secret de signature du webhook, montré une seule fois après l'enregistrement.
  const secretCookie = (await cookies()).get('secret-webhook')?.value;
  let webhookSecret: string | null = null;
  const cipher = tokenCipher();
  if (secretCookie && cipher !== null) {
    try {
      webhookSecret = cipher.decrypt(Buffer.from(secretCookie, 'base64url'), `webhook-affichage:${userId}`);
    } catch {
      webhookSecret = null;
    }
  }

  return (
    <>
      <h1>Comptes LinkedIn</h1>
      <Flash code={message} />
      {webhookSecret !== null && (
        <p className="flash success" role="status">
          Secret de signature du webhook, à copier maintenant dans votre scénario (il ne sera plus affiché) : <code>{webhookSecret}</code>
        </p>
      )}
      <div className="actions">
        <Link href={`/comptes/${workspaceId}/connecter`} className="button">
          {hasMine ? 'Reconnecter mon profil LinkedIn' : 'Connecter mon profil LinkedIn'}
        </Link>
        {/* LNK-02 : une personne qui administre les pages sur LinkedIn les ajoute en une fois. */}
        <form action={startPagesConnection.bind(null, workspaceId)}>
          <button type="submit">Connecter des pages d’entreprise</button>
        </form>
      </div>
      {accounts.length === 0 ? (
        <p className="muted">Aucun compte connecté dans cet espace.</p>
      ) : (
        <ul className="cards">
          {accounts.map((account) => (
            <li key={account.id} className="card">
              <h2>
                {account.name} <small>· {account.kind === 'page' ? 'Page' : 'Profil'}</small>
              </h2>
              <p>
                <span className={`badge ${account.status === 'connected' ? 'status-publie' : 'status-erreur'}`}>{STATUS[account.status] ?? account.status}</span>
                {account.holderName && <span className="muted"> · titulaire : {account.holderName}</span>}
              </p>
              <p className="muted">
                {account.connectionExpiresAt
                  ? `Connexion valable jusqu’au ${dateFormat.format(account.connectionExpiresAt)}.`
                  : 'Aucune connexion active : les posts de ce compte ne partiront pas.'}
              </p>
              <p>
                <Link href={`/comptes/${workspaceId}/fiche/${account.id}`}>Fiche du compte : voix, rythme, créneaux, exemples</Link>
              </p>
              {/* PUB-09, LNK-08 : publication manuelle ou par un scénario du client. */}
              <p className="muted">
                {account.publishMode === 'manual'
                  ? 'Publication manuelle : au créneau, le post validé est envoyé par e-mail au titulaire (texte et images), qui le publie lui-même.'
                  : account.publishMode === 'webhook'
                    ? `Publication par votre scénario : au créneau, le post validé est envoyé à ${account.webhookHost ?? 'votre webhook'}.`
                    : 'Publication automatique au créneau.'}
              </p>
              {account.canDisconnect && (
                <form action={publishModeAction.bind(null, workspaceId, account.id)}>
                  <input type="hidden" name="mode" value={account.publishMode === 'auto' ? 'manual' : 'auto'} />
                  <button type="submit">{account.publishMode === 'auto' ? 'Passer en publication manuelle (par e-mail)' : 'Revenir à la publication automatique'}</button>
                </form>
              )}
              {account.canDisconnect && (
                <details>
                  <summary>Publier par un scénario (Make, Zapier, n8n…)</summary>
                  <p className="hint">
                    Au créneau, le post validé (texte et images) est envoyé en JSON à votre webhook, signé par l’en-tête X-Signature (HMAC-SHA256). Votre scénario le publie ; il peut
                    renvoyer en JSON l’« urn » et l’« url » du post LinkedIn pour le suivi.
                  </p>
                  <form action={webhookAction.bind(null, workspaceId, account.id)} className="inline-fields">
                    <label>
                      Adresse du webhook (https)
                      <input name="webhook" type="url" required placeholder="https://hook.eu1.make.com/…" />
                    </label>
                    <button type="submit">Enregistrer le webhook</button>
                  </form>
                </details>
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
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

import { CHAT_EVENTS, CHAT_PROVIDERS, SUPPORT_MAX_HOURS, getTeamChat, listMembers, listSupportGrants } from '@posts-auto/services';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../../components/flash.tsx';
import { PageHeader } from '../../../../../components/page-header.tsx';
import { database } from '../../../../../server/context.ts';
import { requireUserId } from '../../../../../server/session.ts';
import { grantSupportAction, removeTeamChatAction, revokeSupportAction, saveTeamChatAction, testTeamChatAction } from '../../actions.ts';

export const metadata: Metadata = { title: 'Intégrations et support' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Messagerie d'équipe (Slack ou Teams) et accès du support (ADM-02). */
export default async function IntegrationsPage({
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
  if (!canManage) {
    return (
      <>
        <h1>Intégrations et support</h1>
        <p className="muted">Ces réglages sont réservés aux administrateurs de l’espace.</p>
      </>
    );
  }
  const supportGrants = await listSupportGrants(db, userId, workspaceId, new Date());
  const teamChat = await getTeamChat(db, userId, workspaceId).catch(() => null);
  const when = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <PageHeader title="Intégrations et support" description="Facultatif : Rostra fonctionne sans aucun de ces réglages." />
      <Flash code={message} />

      <details id="messagerie" open={teamChat !== null || (typeof message === 'string' && /messagerie|chat|webhook/i.test(message))}>
        <summary>Messagerie d’équipe (Slack ou Teams)</summary>
        <p className="hint">
          Annoncez dans un canal de l’équipe les posts prêts à valider, les échecs de publication et les posts publiés : quelques réactions et commentaires de l’équipe dans la
          première heure aident un post à être vu. Dans Slack, créez un « webhook entrant » ; dans Teams, un flux Workflows « Publier dans un canal quand une requête webhook est
          reçue ». Collez ici l’adresse obtenue : elle est chiffrée et ne sera plus affichée.
        </p>
        {teamChat !== null && (
          <p>
            {`Reliée à ${CHAT_PROVIDERS[teamChat.provider]} (${teamChat.urlHint})`}
            {teamChat.lastSentAt !== null && ` · dernier message le ${when.format(teamChat.lastSentAt)}`}
            {teamChat.lastError !== null && <strong>{` · dernier envoi en échec : ${teamChat.lastError}`}</strong>}
          </p>
        )}
        <form action={saveTeamChatAction.bind(null, workspaceId)} className="stack">
          <label htmlFor="messagerie-service">Messagerie</label>
          <select id="messagerie-service" name="messagerie" defaultValue={teamChat?.provider ?? 'slack'}>
            {Object.entries(CHAT_PROVIDERS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor="messagerie-adresse">{teamChat === null ? 'Adresse du webhook' : 'Nouvelle adresse du webhook (laisser vide pour garder la même)'}</label>
          <input id="messagerie-adresse" name="adresse" type="url" inputMode="url" autoComplete="off" maxLength={1000} required={teamChat === null} placeholder="https://hooks.slack.com/services/…" />
          <fieldset>
            <legend>Annoncer</legend>
            {Object.entries(CHAT_EVENTS).map(([value, label]) => (
              <label key={value} className="check">
                <input type="checkbox" name="evenements" value={value} defaultChecked={teamChat === null || teamChat.events.includes(value as keyof typeof CHAT_EVENTS)} /> {label}
              </label>
            ))}
          </fieldset>
          <button type="submit">{teamChat === null ? 'Relier la messagerie' : 'Enregistrer'}</button>
        </form>
        {teamChat !== null && (
          <div className="inline-fields">
            <form action={testTeamChatAction.bind(null, workspaceId)}>
              <button type="submit">Envoyer un message d’essai</button>
            </form>
            <form action={removeTeamChatAction.bind(null, workspaceId)}>
              <button type="submit">Retirer la messagerie</button>
            </form>
          </div>
        )}
      </details>

      <details id="support" open={supportGrants.length > 0}>
        <summary>Accès du support</summary>
        <p className="hint">
          Pour qu’une personne du support puisse voir l’espace comme vous le voyez et vous aider, accordez-lui un accès limité dans le temps. Ses interventions sont inscrites au journal
          d’audit ; vous pouvez retirer l’accès à tout moment.
        </p>
        {supportGrants.length > 0 && (
          <ul>
            {supportGrants.map((g) => (
              <li key={g.id}>
                Accordé par {g.grantedBy} jusqu’au {when.format(g.expiresAt)}
                {g.reason && <> · « {g.reason} »</>}
                <form action={revokeSupportAction.bind(null, workspaceId, g.id)} className="inline-fields">
                  <button type="submit">Retirer l’accès</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={grantSupportAction.bind(null, workspaceId)} className="stack">
          <label>
            Durée (heures, {SUPPORT_MAX_HOURS} au plus)
            <input name="heures" type="number" min={1} max={SUPPORT_MAX_HOURS} defaultValue={24} required />
          </label>
          <label>
            Motif (facultatif)
            <input name="motif" maxLength={500} />
          </label>
          <button type="submit">Accorder l’accès au support</button>
        </form>
      </details>
    </>
  );
}

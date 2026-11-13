/**
 * Notifications créées par les tâches de fond (section 5.12). Elles sont enregistrées ici ;
 * leur envoi par e-mail est fait par une tâche dédiée, selon les préférences (NOT-01).
 */
import type { Tx } from '@posts-auto/db';

/** Titulaire du compte, administrateurs de l'espace, propriétaires de l'organisation. */
export async function alertRecipients(trx: Tx, workspaceId: string, accountId: string): Promise<string[]> {
  const holder = await trx.selectFrom('social_accounts').select('holder_user_id').where('id', '=', accountId).executeTakeFirst();
  const admins = await trx
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('role', '=', 'admin')
    .execute();
  const owners = await trx
    .selectFrom('org_members as o')
    .innerJoin('workspaces as w', 'w.org_id', 'o.org_id')
    .select('o.user_id')
    .where('w.id', '=', workspaceId)
    .where('o.role', '=', 'owner')
    .execute();
  const ids = [holder?.holder_user_id, ...admins.map((r) => r.user_id), ...owners.map((r) => r.user_id)];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

export async function notify(
  trx: Tx,
  userIds: readonly string[],
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown>,
  channels: readonly ('email' | 'in_app')[],
): Promise<void> {
  const rows = userIds.flatMap((userId) =>
    channels.map((channel) => ({ user_id: userId, workspace_id: workspaceId, kind, channel, payload: JSON.stringify(payload) })),
  );
  if (rows.length > 0) await trx.insertInto('notifications').values(rows).execute();
}

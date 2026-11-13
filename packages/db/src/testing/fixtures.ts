/**
 * Données de test : organisations, espaces, utilisateurs, comptes et posts, créés en
 * contexte système. Chaque appel produit des données uniques (adresses, URN), pour que
 * les fichiers de test restent indépendants les uns des autres sur la même base.
 */
import { randomUUID } from 'node:crypto';
import type { Insertable } from 'kysely';
import { asSystem } from '../context.js';
import type { Database } from '../client.js';
import type { DB } from '../schema.js';

const unique = () => randomUUID().slice(0, 8);

export async function createUser(db: Database, label = 'user'): Promise<string> {
  return asSystem(db, async (trx) => {
    const row = await trx
      .insertInto('users')
      .values({ email: `${label}.${unique()}@exemple.test`, full_name: label })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

export interface OrgSetup {
  readonly orgId: string;
  readonly workspaceIds: string[];
  readonly ownerId: string;
}

/** Une organisation, son propriétaire et ses espaces. */
export async function createOrganization(
  db: Database,
  options: { kind?: 'entreprise' | 'agence'; workspaces?: number; name?: string } = {},
): Promise<OrgSetup> {
  const ownerId = await createUser(db, 'owner');
  return asSystem(db, async (trx) => {
    const org = await trx
      .insertInto('organizations')
      .values({ name: options.name ?? `Org ${unique()}`, kind: options.kind ?? 'entreprise' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('org_members').values({ org_id: org.id, user_id: ownerId, role: 'owner' }).execute();
    const workspaceIds: string[] = [];
    for (let i = 0; i < (options.workspaces ?? 1); i += 1) {
      const ws = await trx
        .insertInto('workspaces')
        .values({ org_id: org.id, name: `Espace ${unique()}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      workspaceIds.push(ws.id);
    }
    return { orgId: org.id, workspaceIds, ownerId };
  });
}

export async function addMember(
  db: Database,
  workspaceId: string,
  userId: string,
  role: 'admin' | 'editor' | 'contributor' | 'viewer' = 'editor',
): Promise<void> {
  await asSystem(db, (trx) =>
    trx.insertInto('workspace_members').values({ workspace_id: workspaceId, user_id: userId, role }).execute(),
  );
}

export async function createAccount(
  db: Database,
  workspaceId: string,
  values: Partial<Insertable<DB['social_accounts']>> = {},
): Promise<string> {
  return asSystem(db, async (trx) => {
    const row = await trx
      .insertInto('social_accounts')
      .values({
        workspace_id: workspaceId,
        kind: 'profile',
        external_urn: `urn:li:person:${unique()}`,
        display_name: 'Compte de test',
        ...values,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/** Un post et sa première révision. */
export async function createPost(
  db: Database,
  workspaceId: string,
  accountId: string,
  values: Partial<Insertable<DB['posts']>> & { body?: string } = {},
): Promise<string> {
  const { body = 'Texte du post.', ...postValues } = values;
  return asSystem(db, async (trx) => {
    const post = await trx
      .insertInto('posts')
      .values({
        workspace_id: workspaceId,
        account_id: accountId,
        week_start: '2026-11-16',
        scheduled_at: new Date('2026-11-17T11:00:00Z'),
        status: 'a_valider',
        origin: 'planning',
        ...postValues,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const version = await trx
      .insertInto('post_versions')
      .values({ workspace_id: workspaceId, post_id: post.id, revision: 1, body, author_kind: 'ai' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.updateTable('posts').set({ current_version_id: version.id }).where('id', '=', post.id).execute();
    return post.id;
  });
}

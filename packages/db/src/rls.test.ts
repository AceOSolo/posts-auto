/**
 * Cloisonnement des clients (SEC-01, REC-01, ROL-02) : vérifié dans la base elle-même,
 * avec le rôle de l'application web, sans passer par le code applicatif.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type Database, createDatabase } from './client.js';
import { asSystem, asUser } from './context.js';
import {
  type OrgSetup,
  addMember,
  createAccount,
  createOrganization,
  createPost,
  createUser,
} from './testing/fixtures.js';

let db: Database;
let orgA: OrgSetup;
let orgB: OrgSetup;
let agency: OrgSetup;
let alice: string; // admin de l'espace A
let bob: string; // membre de l'espace B
let carla: string; // cliente de l'agence, membre du seul premier espace de l'agence
let accountA: string;
let accountB: string;
let postA: string;
let postB: string;

const wsA = () => orgA.workspaceIds[0] as string;
const wsB = () => orgB.workspaceIds[0] as string;

beforeAll(async () => {
  db = createDatabase(inject('databaseUrl'), { maxConnections: 4 });
  orgA = await createOrganization(db);
  orgB = await createOrganization(db);
  agency = await createOrganization(db, { kind: 'agence', workspaces: 2 });

  alice = await createUser(db, 'alice');
  bob = await createUser(db, 'bob');
  carla = await createUser(db, 'carla');
  await addMember(db, wsA(), alice, 'admin');
  await addMember(db, wsB(), bob, 'editor');
  await addMember(db, agency.workspaceIds[0] as string, carla, 'viewer');

  accountA = await createAccount(db, wsA());
  accountB = await createAccount(db, wsB());
  postA = await createPost(db, wsA(), accountA);
  postB = await createPost(db, wsB(), accountB);
});

afterAll(async () => {
  await db.destroy();
});

describe('isolation entre clients (SEC-01, REC-01)', () => {
  it('un utilisateur de A ne trouve pas un post de B (l’application répondra 404)', async () => {
    const found = await asUser(db, alice, (trx) =>
      trx.selectFrom('posts').select('id').where('id', '=', postB).executeTakeFirst(),
    );
    expect(found).toBeUndefined();
  });

  it('il trouve ses propres posts', async () => {
    const ids = await asUser(db, alice, (trx) => trx.selectFrom('posts').select('id').execute());
    expect(ids.map((row) => row.id)).toContain(postA);
    expect(ids.map((row) => row.id)).not.toContain(postB);
  });

  it('il ne peut pas créer de post dans l’espace d’un autre client', async () => {
    const attempt = asUser(db, alice, (trx) =>
      trx
        .insertInto('posts')
        .values({
          workspace_id: wsB(),
          account_id: accountB,
          week_start: '2026-11-16',
          scheduled_at: new Date('2026-11-18T11:00:00Z'),
          origin: 'planning',
        })
        .execute(),
    );
    await expect(attempt).rejects.toThrow(/row-level security/);
  });

  it('il ne peut ni modifier ni supprimer un post d’un autre client', async () => {
    const updated = await asUser(db, alice, (trx) =>
      trx.updateTable('posts').set({ motif: 'piraté' }).where('id', '=', postB).executeTakeFirst(),
    );
    const deleted = await asUser(db, alice, (trx) =>
      trx.deleteFrom('posts').where('id', '=', postB).executeTakeFirst(),
    );
    expect(updated.numUpdatedRows).toBe(0n);
    expect(deleted.numDeletedRows).toBe(0n);
  });

  it('il ne peut pas déplacer un de ses posts vers l’espace d’un autre client', async () => {
    const attempt = asUser(db, alice, (trx) =>
      trx.updateTable('posts').set({ workspace_id: wsB() }).where('id', '=', postA).execute(),
    );
    await expect(attempt).rejects.toThrow(/row-level security|foreign key/);
  });

  it('il ne peut pas rattacher une révision de son espace au post d’un autre client', async () => {
    // La RLS laisserait passer (la ligne porte son propre espace) : c'est la clé
    // étrangère composite (post_id, workspace_id) qui l'interdit.
    const attempt = asUser(db, alice, (trx) =>
      trx
        .insertInto('post_versions')
        .values({ workspace_id: wsA(), post_id: postB, revision: 99, body: 'Intrus', author_kind: 'user' })
        .execute(),
    );
    await expect(attempt).rejects.toThrow(/foreign key/);
  });

  it('sans utilisateur dans le contexte, l’application web ne voit rien', async () => {
    const count = await db.transaction().execute(async (trx) => {
      await sql`set local role app_web`.execute(trx);
      return trx.selectFrom('posts').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    });
    expect(count.n).toBe('0');
  });

  it('un utilisateur ne voit pas les personnes d’un autre client', async () => {
    const visible = await asUser(db, alice, (trx) =>
      trx.selectFrom('users').select('id').where('id', 'in', [alice, bob]).execute(),
    );
    expect(visible.map((row) => row.id)).toEqual([alice]);
  });

  it('les tâches de fond (contexte système) voient tous les espaces', async () => {
    const ids = await asSystem(db, (trx) =>
      trx.selectFrom('posts').select('id').where('id', 'in', [postA, postB]).execute(),
    );
    expect(ids).toHaveLength(2);
  });
});

describe('données réservées au système', () => {
  it('l’application web n’a aucun accès aux jetons LinkedIn (SEC-02)', async () => {
    const attempt = asUser(db, alice, (trx) => trx.selectFrom('social_tokens').selectAll().execute());
    await expect(attempt).rejects.toThrow(/permission denied/);
  });

  it('ni aux liens de validation, ni aux sessions', async () => {
    await expect(asUser(db, alice, (trx) => trx.selectFrom('approval_links').selectAll().execute())).rejects.toThrow(
      /permission denied/,
    );
    await expect(asUser(db, alice, (trx) => trx.selectFrom('sessions').selectAll().execute())).rejects.toThrow(
      /permission denied/,
    );
  });

  it('l’historique des statuts se complète mais ne se réécrit pas', async () => {
    await asUser(db, alice, (trx) =>
      trx
        .insertInto('post_status_history')
        .values({ workspace_id: wsA(), post_id: postA, from_status: 'a_valider', to_status: 'valide', actor_kind: 'user', actor_user_id: alice })
        .execute(),
    );
    const rewrite = asUser(db, alice, (trx) =>
      trx.updateTable('post_status_history').set({ reason: 'réécrit' }).where('post_id', '=', postA).execute(),
    );
    await expect(rewrite).rejects.toThrow(/permission denied/);
  });
});

describe('agences (ROL-02)', () => {
  it('une cliente d’agence ne voit que son espace, jamais les autres clients', async () => {
    const workspaces = await asUser(db, carla, (trx) => trx.selectFrom('workspaces').select('id').execute());
    expect(workspaces.map((row) => row.id)).toEqual([agency.workspaceIds[0]]);
  });

  it('elle voit le nom de son agence, et aucune autre organisation', async () => {
    const orgs = await asUser(db, carla, (trx) => trx.selectFrom('organizations').select('id').execute());
    expect(orgs.map((row) => row.id)).toEqual([agency.orgId]);
  });

  it('le propriétaire de l’agence voit tous les espaces de son organisation', async () => {
    const workspaces = await asUser(db, agency.ownerId, (trx) =>
      trx.selectFrom('workspaces').select('id').orderBy('created_at').execute(),
    );
    expect(workspaces.map((row) => row.id).sort()).toEqual([...agency.workspaceIds].sort());
  });

  it('le journal de niveau organisation (facturation…) reste invisible pour la cliente', async () => {
    const [clientWs] = agency.workspaceIds as [string];
    await asSystem(db, (trx) =>
      trx
        .insertInto('audit_log')
        .values([
          { org_id: agency.orgId, workspace_id: null, actor_kind: 'system', action: 'facturation.modifiee', entity: 'subscription' },
          { org_id: agency.orgId, workspace_id: clientWs, actor_kind: 'system', action: 'post.valide', entity: 'post' },
        ])
        .execute(),
    );
    const seenByClient = await asUser(db, carla, (trx) =>
      trx.selectFrom('audit_log').select('action').where('org_id', '=', agency.orgId).execute(),
    );
    const seenByOwner = await asUser(db, agency.ownerId, (trx) =>
      trx.selectFrom('audit_log').select('action').where('org_id', '=', agency.orgId).execute(),
    );
    expect(seenByClient.map((row) => row.action)).toEqual(['post.valide']);
    expect(seenByOwner.map((row) => row.action).sort()).toEqual(['facturation.modifiee', 'post.valide']);
  });

  it('une entrée de journal ne peut pas associer un espace à une autre organisation', async () => {
    const attempt = asSystem(db, (trx) =>
      trx
        .insertInto('audit_log')
        .values({ org_id: orgB.orgId, workspace_id: wsA(), actor_kind: 'system', action: 'x', entity: 'x' })
        .execute(),
    );
    await expect(attempt).rejects.toThrow(/foreign key/);
  });
});

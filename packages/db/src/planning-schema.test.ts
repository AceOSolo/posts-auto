/**
 * Schéma de l'incrément 1b : ligne éditoriale, planning, idées, demandes, générations.
 * Cloisonnement et contraintes vérifiés dans la base, avec le rôle de l'application web.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.ts';
import { asSystem, asUser } from './context.ts';
import { closeTestDatabase, openTestDatabase } from './testing/test-database.ts';
import { type OrgSetup, addMember, createAccount, createOrganization, createPost, createUser } from './testing/fixtures.ts';

let db: Database;
let orgA: OrgSetup;
let orgB: OrgSetup;
let alice: string; // éditrice de l'espace A
let accountA: string;
let accountB: string;

const wsA = () => orgA.workspaceIds[0] as string;
const wsB = () => orgB.workspaceIds[0] as string;
const RULES = { hashtags: 0 };

beforeAll(async () => {
  db = await openTestDatabase();
  orgA = await createOrganization(db);
  orgB = await createOrganization(db);
  alice = await createUser(db, 'alice');
  await addMember(db, wsA(), alice, 'editor');
  accountA = await createAccount(db, wsA());
  accountB = await createAccount(db, wsB());
});
afterAll(() => closeTestDatabase(db));

describe('protection des tables (SEC-01)', () => {
  it('toutes les tables de la base ont la sécurité au niveau des lignes activée', async () => {
    const unprotected = await asSystem(db, async (trx) => {
      const result = await sql<{ tablename: string }>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY tablename`.execute(trx);
      return result.rows.map((r) => r.tablename);
    });
    expect(unprotected).toEqual([]);
  });

  it('une éditrice de A ne voit ni n’écrit les idées, le planning ou les demandes de B', async () => {
    await asSystem(db, async (trx) => {
      await trx.insertInto('ideas').values({ workspace_id: wsB(), title: 'Idée de B', origin: 'team' }).execute();
      await trx
        .insertInto('planning_cells')
        .values({ workspace_id: wsB(), row_kind: 'account', account_id: accountB, week_start: '2026-11-16', content: 'Sujet B' })
        .execute();
    });
    const seen = await asUser(db, alice, async (trx) => ({
      ideas: await trx.selectFrom('ideas').select('id').where('workspace_id', '=', wsB()).execute(),
      cells: await trx.selectFrom('planning_cells').select('id').where('workspace_id', '=', wsB()).execute(),
    }));
    expect(seen).toEqual({ ideas: [], cells: [] });
    await expect(
      asUser(db, alice, (trx) => trx.insertInto('ideas').values({ workspace_id: wsB(), title: 'Intrusion', origin: 'team' }).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it('une idée de A ne peut pas viser un compte de B (clé composite)', async () => {
    const attempt = asUser(db, alice, async (trx) => {
      const idea = await trx.insertInto('ideas').values({ workspace_id: wsA(), title: 'Idée', origin: 'team' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('idea_accounts').values({ idea_id: idea.id, account_id: accountB, workspace_id: wsA() }).execute();
    });
    await expect(attempt).rejects.toThrow(/idea_accounts_account_id_workspace_id_fkey/);
  });

  it('l’application web lit les générations et les coûts sans pouvoir les écrire', async () => {
    await expect(
      asUser(db, alice, (trx) => trx.insertInto('generation_runs').values({ workspace_id: wsA(), kind: 'weekly' }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice, (trx) =>
        trx.insertInto('ai_usage').values({ workspace_id: wsA(), provider: 'x', model: 'm', purpose: 'write', kind: 'text' }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('ligne éditoriale (EDI-01, EDI-07)', () => {
  it('une seule version en vigueur par espace', async () => {
    const ws = (await createOrganization(db)).workspaceIds[0] as string;
    await asSystem(db, (trx) => trx.insertInto('editorial_lines').values({ workspace_id: ws, version: 1, rules: JSON.stringify(RULES) }).execute());
    await expect(
      asSystem(db, (trx) => trx.insertInto('editorial_lines').values({ workspace_id: ws, version: 2, rules: JSON.stringify(RULES) }).execute()),
    ).rejects.toThrow(/editorial_lines_current_idx/);
    await asSystem(db, async (trx) => {
      await trx.updateTable('editorial_lines').set({ is_current: false }).where('workspace_id', '=', ws).execute();
      await trx.insertInto('editorial_lines').values({ workspace_id: ws, version: 2, rules: JSON.stringify(RULES) }).execute();
    });
  });
});

describe('planning (PLA-01, PLA-02)', () => {
  const cell = (values: Record<string, unknown>) =>
    asSystem(db, (trx) =>
      trx
        .insertInto('planning_cells')
        .values({ workspace_id: wsA(), row_kind: 'account', account_id: accountA, week_start: '2026-11-23', content: 'Sujet', ...values })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );

  it('une case peut contenir plusieurs sujets, chacun à sa position', async () => {
    await cell({ position: 1 });
    await cell({ position: 2, content: 'Second sujet' });
    await expect(cell({ position: 2 })).rejects.toThrow(/planning_cells_workspace_id_row_kind_account_id_row_label_w_key/);
  });

  it('les lignes sans compte sont distinguées par leur libellé, même avec des valeurs nulles', async () => {
    const event = { row_kind: 'event', account_id: null, row_label: 'Salons', week_start: '2026-11-30' };
    await cell(event);
    await expect(cell(event)).rejects.toThrow(/planning_cells_workspace_id_row_kind_account_id_row_label_w_key/);
    await expect(cell({ row_kind: 'event', account_id: null, row_label: null })).rejects.toThrow(/planning_cells_check1/);
    await expect(cell({ row_kind: 'event' })).rejects.toThrow(/planning_cells_check/);
  });

  it('la semaine est un lundi ; « mis de côté » exige un motif', async () => {
    await expect(cell({ week_start: '2026-11-24' })).rejects.toThrow(/planning_cells_week_start_check/);
    await expect(cell({ week_start: '2026-12-07', set_aside_at: new Date() })).rejects.toThrow(/planning_cells_check2/);
  });

  it('supprimer un sujet du planning garde le post qui en est issu', async () => {
    const { id: cellId } = await cell({ week_start: '2026-12-14' });
    const postId = await createPost(db, wsA(), accountA, { planning_cell_id: cellId, scheduled_at: new Date('2026-12-15T11:00:00Z'), week_start: '2026-12-14' });
    await asSystem(db, (trx) => trx.deleteFrom('planning_cells').where('id', '=', cellId).execute());
    const post = await asSystem(db, (trx) => trx.selectFrom('posts').select('planning_cell_id').where('id', '=', postId).executeTakeFirstOrThrow());
    expect(post.planning_cell_id).toBeNull();
  });
});

describe('demandes et générations', () => {
  it('une demande a un texte ; ses photos sont 9 au plus, réordonnables en une transaction', async () => {
    await expect(
      asSystem(db, (trx) => trx.insertInto('post_requests').values({ workspace_id: wsA(), created_by: alice, raw_text: '  ' }).execute()),
    ).rejects.toThrow(/post_requests_check/);
    const { requestId, assetIds } = await asSystem(db, async (trx) => {
      const request = await trx.insertInto('post_requests').values({ workspace_id: wsA(), created_by: alice, raw_text: 'Salon' }).returning('id').executeTakeFirstOrThrow();
      const assets = await trx
        .insertInto('media_assets')
        .values([1, 2, 3].map((n) => ({ workspace_id: wsA(), kind: 'upload' as const, storage_key: `test/${request.id}/${n}.png`, mime: 'image/png' })))
        .returning('id')
        .execute();
      await trx
        .insertInto('request_photos')
        .values(assets.slice(0, 2).map((a, i) => ({ request_id: request.id, asset_id: a.id, workspace_id: wsA(), position: i + 1 })))
        .execute();
      return { requestId: request.id, assetIds: assets.map((a) => a.id) };
    });
    // Échange des positions 1 et 2 en une instruction (contrainte reportée).
    await asSystem(db, (trx) => trx.updateTable('request_photos').set({ position: sql`3 - position` }).where('request_id', '=', requestId).execute());
    await expect(
      asSystem(db, (trx) =>
        trx.insertInto('request_photos').values({ request_id: requestId, asset_id: assetIds[2] as string, workspace_id: wsA(), position: 10 }).execute(),
      ),
    ).rejects.toThrow(/request_photos_position_check/);
  });

  it('une seule génération hebdomadaire en cours par espace', async () => {
    const ws = (await createOrganization(db)).workspaceIds[0] as string;
    await asSystem(db, (trx) => trx.insertInto('generation_runs').values({ workspace_id: ws, kind: 'weekly' }).execute());
    await expect(
      asSystem(db, (trx) => trx.insertInto('generation_runs').values({ workspace_id: ws, kind: 'weekly' }).execute()),
    ).rejects.toThrow(/generation_runs_one_weekly_idx/);
    await asSystem(db, (trx) => trx.insertInto('generation_runs').values({ workspace_id: ws, kind: 'request' }).execute());
  });

  it('supprimer une organisation efface son planning, ses idées, ses demandes et ses générations', async () => {
    const doomed = await createOrganization(db);
    const ws = doomed.workspaceIds[0] as string;
    const user = await createUser(db, 'demandeur');
    const account = await createAccount(db, ws);
    await asSystem(db, async (trx) => {
      const subject = await trx.insertInto('subject_bank').values({ workspace_id: ws, account_id: account, subject: 'Sujet' }).returning('id').executeTakeFirstOrThrow();
      const cellRow = await trx
        .insertInto('planning_cells')
        .values({ workspace_id: ws, row_kind: 'account', account_id: account, week_start: '2026-11-16', content: 'Case', subject_id: subject.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      const idea = await trx.insertInto('ideas').values({ workspace_id: ws, title: 'Idée', origin: 'team' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('idea_accounts').values({ idea_id: idea.id, account_id: account, workspace_id: ws }).execute();
      const event = await trx.insertInto('events').values({ workspace_id: ws, title: 'Salon', starts_on: '2026-12-01' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('event_accounts').values({ event_id: event.id, account_id: account, workspace_id: ws }).execute();
      const request = await trx.insertInto('post_requests').values({ workspace_id: ws, created_by: user, raw_text: 'Demande' }).returning('id').executeTakeFirstOrThrow();
      const run = await trx.insertInto('generation_runs').values({ workspace_id: ws, kind: 'weekly' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('ai_usage').values({ workspace_id: ws, run_id: run.id, provider: 'x', model: 'm', purpose: 'write', kind: 'text' }).execute();
      await trx.insertInto('editorial_lines').values({ workspace_id: ws, version: 1, rules: JSON.stringify(RULES) }).execute();
      await trx.insertInto('reference_posts').values({ workspace_id: ws, account_id: account, body: 'Exemple', label: 'imiter' }).execute();
      return { cell: cellRow.id, idea: idea.id, event: event.id, request: request.id, run: run.id, subject: subject.id };
    }).then((ids) =>
      createPost(db, ws, account, {
        planning_cell_id: ids.cell,
        subject_id: ids.subject,
        idea_id: ids.idea,
        event_id: ids.event,
        request_id: ids.request,
        generation_run_id: ids.run,
      }),
    ).then((postId) =>
      asSystem(db, async (trx) => {
        await trx.insertInto('ideas').values({ workspace_id: ws, title: 'Réserve', origin: 'ai_reserve', from_post_id: postId }).execute();
        await trx.insertInto('content_reports').values({ workspace_id: ws, post_id: postId, reported_by: user, reason: 'Inexact' }).execute();
      }),
    );

    await asSystem(db, (trx) => trx.deleteFrom('organizations').where('id', '=', doomed.orgId).execute());

    const left = await asSystem(db, async (trx) => {
      const count = async (table: 'posts' | 'ideas' | 'planning_cells' | 'post_requests' | 'generation_runs' | 'ai_usage' | 'subject_bank' | 'events') =>
        (await trx.selectFrom(table).select('workspace_id').where('workspace_id', '=', ws).execute()).length;
      return [await count('posts'), await count('ideas'), await count('planning_cells'), await count('post_requests'), await count('generation_runs'), await count('ai_usage'), await count('subject_bank'), await count('events')];
    });
    expect(left).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

/**
 * Contraintes du schéma qui portent des règles métier, et concordance avec @posts-auto/core.
 */
import { POST_STATUSES, hasBlockingMarkers } from '@posts-auto/core';
import { BLOCKING_MARKER_SAMPLES } from '@posts-auto/core/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { asSystem } from './context.js';
import { closeTestDatabase, openTestDatabase } from './testing/test-database.js';
import { type OrgSetup, createAccount, createOrganization, createPost } from './testing/fixtures.js';

let db: Database;
let org: OrgSetup;
const ws = () => org.workspaceIds[0] as string;

beforeAll(async () => {
  db = await openTestDatabase();
  org = await createOrganization(db, { workspaces: 2 });
});

afterAll(() => closeTestDatabase(db));

describe('concordance avec le moteur de règles', () => {
  it('la contrainte sur posts.status liste exactement les statuts de @posts-auto/core', async () => {
    const { rows } = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'posts'::regclass and conname = 'posts_status_check'`.execute(db);
    const statuses = [...(rows[0]?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);
    expect(statuses.sort()).toEqual([...POST_STATUSES].sort());
  });

  it('la colonne has_blocking_markers détecte les mêmes marqueurs que hasBlockingMarkers() (VAL-03)', async () => {
    const accountId = await createAccount(db, ws());
    const postId = await createPost(db, ws(), accountId);
    const results = await asSystem(db, async (trx) => {
      const rows = [];
      for (const [index, [text]] of BLOCKING_MARKER_SAMPLES.entries()) {
        rows.push(
          await trx
            .insertInto('post_versions')
            .values({ workspace_id: ws(), post_id: postId, revision: index + 2, body: text, author_kind: 'user' })
            .returning(['body', 'has_blocking_markers'])
            .executeTakeFirstOrThrow(),
        );
      }
      return rows;
    });
    for (const [index, [text, expected]] of BLOCKING_MARKER_SAMPLES.entries()) {
      expect(results[index]?.has_blocking_markers, text).toBe(expected);
      expect(hasBlockingMarkers(text), text).toBe(expected);
    }
  });
});

describe('règles portées par les contraintes', () => {
  it('RÈG-03 : un compte n’a jamais deux posts actifs sur le même créneau', async () => {
    const accountId = await createAccount(db, ws());
    const slot = new Date('2026-11-19T11:00:00Z');
    await createPost(db, ws(), accountId, { scheduled_at: slot });
    await expect(createPost(db, ws(), accountId, { scheduled_at: slot })).rejects.toThrow(/posts_one_per_slot_idx/);
    // Un post sorti de la validation (demande de modification) ne bloque pas le créneau.
    await expect(createPost(db, ws(), accountId, { scheduled_at: slot, status: 'modif' })).resolves.toBeTypeOf('string');
  });

  it('LNK-06 : un compte LinkedIn dans un seul espace actif, reconnectable ailleurs une fois révoqué', async () => {
    const urn = `urn:li:organization:${Date.now()}`;
    const first = await createAccount(db, ws(), { external_urn: urn, kind: 'page' });
    const otherWorkspace = org.workspaceIds[1] as string;
    await expect(createAccount(db, otherWorkspace, { external_urn: urn, kind: 'page' })).rejects.toThrow(
      /social_accounts_one_active_idx/,
    );
    await asSystem(db, (trx) => trx.updateTable('social_accounts').set({ status: 'revoked' }).where('id', '=', first).execute());
    await expect(createAccount(db, otherWorkspace, { external_urn: urn, kind: 'page' })).resolves.toBeTypeOf('string');
  });

  it('VIS-09 : l’ordre des images se modifie en une transaction (échange des positions 1 et 2)', async () => {
    const accountId = await createAccount(db, ws());
    const postId = await createPost(db, ws(), accountId, { scheduled_at: new Date('2026-11-20T11:00:00Z') });
    const [first, second] = await asSystem(db, async (trx) => {
      const assets = await trx
        .insertInto('media_assets')
        .values([1, 2].map((n) => ({ workspace_id: ws(), kind: 'upload', storage_key: `test/${postId}/${n}.png`, mime: 'image/png' })))
        .returning('id')
        .execute();
      await trx
        .insertInto('post_media')
        .values(assets.map((asset, index) => ({ workspace_id: ws(), post_id: postId, asset_id: asset.id, position: index + 1 })))
        .execute();
      return assets.map((asset) => asset.id);
    });
    await asSystem(db, async (trx) => {
      await trx.updateTable('post_media').set({ position: 2 }).where('asset_id', '=', first as string).execute();
      await trx.updateTable('post_media').set({ position: 1 }).where('asset_id', '=', second as string).execute();
    });
    const order = await asSystem(db, (trx) =>
      trx.selectFrom('post_media').select('asset_id').where('post_id', '=', postId).orderBy('position').execute(),
    );
    expect(order.map((row) => row.asset_id)).toEqual([second, first]);
  });

  it('au plus 9 images par post (limite LinkedIn)', async () => {
    const accountId = await createAccount(db, ws());
    const postId = await createPost(db, ws(), accountId, { scheduled_at: new Date('2026-11-23T11:00:00Z') });
    const attempt = asSystem(db, async (trx) => {
      const asset = await trx
        .insertInto('media_assets')
        .values({ workspace_id: ws(), kind: 'upload', storage_key: `test/${postId}/10.png`, mime: 'image/png' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('post_media').values({ workspace_id: ws(), post_id: postId, asset_id: asset.id, position: 10 }).execute();
    });
    await expect(attempt).rejects.toThrow(/post_media_position_check/);
  });

  it('la version courante d’un post lui appartient forcément', async () => {
    const accountId = await createAccount(db, ws());
    const postX = await createPost(db, ws(), accountId, { scheduled_at: new Date('2026-11-24T11:00:00Z') });
    const postY = await createPost(db, ws(), accountId, { scheduled_at: new Date('2026-11-25T11:00:00Z') });
    const attempt = asSystem(db, async (trx) => {
      const versionOfY = await trx
        .selectFrom('posts')
        .select('current_version_id')
        .where('id', '=', postY)
        .executeTakeFirstOrThrow();
      await trx.updateTable('posts').set({ current_version_id: versionOfY.current_version_id }).where('id', '=', postX).execute();
    });
    await expect(attempt).rejects.toThrow(/posts_current_version_fk/);
  });

  it('un post publié a forcément une date et une référence LinkedIn', async () => {
    const accountId = await createAccount(db, ws());
    await expect(
      createPost(db, ws(), accountId, { status: 'publie', scheduled_at: new Date('2026-11-26T11:00:00Z') }),
    ).rejects.toThrow(/posts_check/);
  });

  it('week_start est toujours un lundi, lu sous forme de date sans fuseau', async () => {
    const accountId = await createAccount(db, ws());
    await expect(
      createPost(db, ws(), accountId, { week_start: '2026-11-17', scheduled_at: new Date('2026-11-27T11:00:00Z') }),
    ).rejects.toThrow(/posts_week_start_check/);
    const postId = await createPost(db, ws(), accountId, { scheduled_at: new Date('2026-11-27T11:00:00Z') });
    const row = await asSystem(db, (trx) =>
      trx.selectFrom('posts').select('week_start').where('id', '=', postId).executeTakeFirstOrThrow(),
    );
    expect(row.week_start).toBe('2026-11-16');
  });

  it('un texte de post ne dépasse pas 3 000 caractères (limite LinkedIn)', async () => {
    const accountId = await createAccount(db, ws());
    await expect(
      createPost(db, ws(), accountId, { body: 'x'.repeat(3001), scheduled_at: new Date('2026-11-30T11:00:00Z') }),
    ).rejects.toThrow(/post_versions_body_check/);
  });
});

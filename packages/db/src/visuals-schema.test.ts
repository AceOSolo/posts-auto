/**
 * Schéma de l'incrément 1c : modèles, médiathèque, visuels à préparer.
 * Cloisonnement et contraintes vérifiés dans la base, avec le rôle de l'application web.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.ts';
import { asSystem, asUser } from './context.ts';
import { closeTestDatabase, openTestDatabase } from './testing/test-database.ts';
import { type OrgSetup, addMember, createAccount, createOrganization, createPost, createUser } from './testing/fixtures.ts';

let db: Database;
let orgA: OrgSetup;
let orgB: OrgSetup;
let alice: string; // administratrice de l'espace A
let accountA: string;
let accountB: string;

const wsA = () => orgA.workspaceIds[0] as string;
const wsB = () => orgB.workspaceIds[0] as string;

const definition = (format: 'square' | 'portrait', kinds: string[]) => ({
  format,
  background: '#ffffff',
  zones: kinds.map((kind, i) => ({ key: `z${i}`, kind, box: { x: 0, y: 0, w: 100, h: 100 } })),
});

beforeAll(async () => {
  db = await openTestDatabase();
  orgA = await createOrganization(db);
  orgB = await createOrganization(db);
  alice = await createUser(db, 'alice');
  await addMember(db, wsA(), alice, 'admin');
  accountA = await createAccount(db, wsA());
  accountB = await createAccount(db, wsB());
});
afterAll(() => closeTestDatabase(db));

describe('modèles (VIS-01)', () => {
  it('indique si le modèle porte une photo, d’après sa définition', async () => {
    const rows = await asUser(db, alice, (trx) =>
      trx
        .insertInto('templates')
        .values([
          { workspace_id: wsA(), name: 'Texte', format: 'square', definition: JSON.stringify(definition('square', ['title', 'bullets'])) },
          { workspace_id: wsA(), name: 'Photo', format: 'portrait', definition: JSON.stringify(definition('portrait', ['photo', 'title'])) },
        ])
        .returning(['name', 'has_photo'])
        .execute(),
    );
    expect(rows).toEqual([
      { name: 'Texte', has_photo: false },
      { name: 'Photo', has_photo: true },
    ]);
  });

  it('refuse une définition d’un autre format que la colonne', async () => {
    await expect(
      asUser(db, alice, (trx) =>
        trx.insertInto('templates').values({ workspace_id: wsA(), name: 'Faux', format: 'square', definition: JSON.stringify(definition('portrait', ['title'])) }).execute(),
      ),
    ).rejects.toThrow(/templates_check/);
  });

  it('ne garde qu’une copie de chaque modèle de départ par espace', async () => {
    const insert = () =>
      asUser(db, alice, (trx) =>
        trx
          .insertInto('templates')
          .values({ workspace_id: wsA(), name: 'Citation', format: 'square', gallery_key: 'citation', definition: JSON.stringify(definition('square', ['title'])) })
          .execute(),
      );
    await insert();
    await expect(insert()).rejects.toThrow(/templates_gallery_idx/);
  });

  it('cloisonne les modèles par espace, y compris le compte visé', async () => {
    await asSystem(db, (trx) =>
      trx.insertInto('templates').values({ workspace_id: wsB(), name: 'Modèle de B', format: 'square', definition: JSON.stringify(definition('square', ['title'])) }).execute(),
    );
    expect(await asUser(db, alice, (trx) => trx.selectFrom('templates').select('id').where('workspace_id', '=', wsB()).execute())).toEqual([]);
    await expect(
      asUser(db, alice, (trx) =>
        trx
          .insertInto('templates')
          .values({ workspace_id: wsA(), account_id: accountB, name: 'Intrus', format: 'square', definition: JSON.stringify(definition('square', ['title'])) })
          .execute(),
      ),
    ).rejects.toThrow(/templates_account_id_workspace_id_fkey/);
  });

  it('ne se supprime pas depuis l’application : il s’archive', async () => {
    await expect(asUser(db, alice, (trx) => trx.deleteFrom('templates').where('workspace_id', '=', wsA()).execute())).rejects.toThrow(/permission denied/);
  });
});

describe('médiathèque et visuels rendus (VIS-03, VIS-08)', () => {
  it('n’accepte que des photos dans la médiathèque', async () => {
    await expect(
      asUser(db, alice, (trx) =>
        trx.insertInto('media_assets').values({ workspace_id: wsA(), kind: 'rendered', storage_key: `test/${wsA()}/r.png`, mime: 'image/png', in_library: true }).execute(),
      ),
    ).rejects.toThrow(/media_assets_library_check/);
    await expect(
      asUser(db, alice, (trx) =>
        trx.insertInto('media_assets').values({ workspace_id: wsA(), kind: 'upload', storage_key: `test/${wsA()}/u.png`, mime: 'image/png', render_content: JSON.stringify({ title: 'x' }) }).execute(),
      ),
    ).rejects.toThrow(/media_assets_render_check/);
  });

  it('garde la recette d’un visuel rendu, et le visuel survit à sa photo', async () => {
    const { photo, rendered } = await asUser(db, alice, async (trx) => {
      const template = await trx
        .insertInto('templates')
        .values({ workspace_id: wsA(), name: 'Recette', format: 'square', definition: JSON.stringify(definition('square', ['photo', 'title'])) })
        .returning('id')
        .executeTakeFirstOrThrow();
      const photo = await trx
        .insertInto('media_assets')
        .values({ workspace_id: wsA(), kind: 'generated', ai_generated: true, storage_key: `test/${wsA()}/g.png`, mime: 'image/png', in_library: true, folder: 'Chantiers', tags: ['casque'] })
        .returning('id')
        .executeTakeFirstOrThrow();
      const rendered = await trx
        .insertInto('media_assets')
        .values({
          workspace_id: wsA(),
          kind: 'rendered',
          ai_generated: true,
          storage_key: `test/${wsA()}/v.png`,
          mime: 'image/png',
          template_id: template.id,
          source_asset_id: photo.id,
          render_content: JSON.stringify({ title: 'Titre' }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { photo: photo.id, rendered: rendered.id };
    });
    await asUser(db, alice, (trx) => trx.deleteFrom('media_assets').where('id', '=', photo).execute());
    const row = await asUser(db, alice, (trx) => trx.selectFrom('media_assets').select(['source_asset_id', 'template_id']).where('id', '=', rendered).executeTakeFirstOrThrow());
    expect(row.source_asset_id).toBeNull();
    expect(row.template_id).not.toBeNull();
  });

  it('ne laisse pas un visuel citer la photo d’un autre espace', async () => {
    const foreign = await asSystem(db, (trx) =>
      trx.insertInto('media_assets').values({ workspace_id: wsB(), kind: 'upload', storage_key: `test/${wsB()}/b.png`, mime: 'image/png' }).returning('id').executeTakeFirstOrThrow(),
    );
    await expect(
      asUser(db, alice, (trx) =>
        trx
          .insertInto('media_assets')
          .values({ workspace_id: wsA(), kind: 'rendered', storage_key: `test/${wsA()}/x.png`, mime: 'image/png', source_asset_id: foreign.id, render_content: '{}' })
          .execute(),
      ),
    ).rejects.toThrow(/media_assets_source_fk/);
  });
});

describe('visuels à préparer (VIS-13)', () => {
  it('une seule tâche par post, supprimée avec le post', async () => {
    const postId = await createPost(db, wsA(), accountA);
    await asUser(db, alice, (trx) =>
      trx.insertInto('visual_tasks').values({ post_id: postId, workspace_id: wsA(), reason: 'redo', instruction: 'Photo plus lumineuse', new_photo: true, requested_by: alice }).execute(),
    );
    await expect(
      asUser(db, alice, (trx) => trx.insertInto('visual_tasks').values({ post_id: postId, workspace_id: wsA(), reason: 'new' }).execute()),
    ).rejects.toThrow(/visual_tasks_pkey/);
    await asSystem(db, (trx) => trx.deleteFrom('posts').where('id', '=', postId).execute());
    expect(await asSystem(db, (trx) => trx.selectFrom('visual_tasks').select('post_id').where('post_id', '=', postId).execute())).toEqual([]);
  });

  it('refuse une tâche sur le post d’un autre espace', async () => {
    const postB = await createPost(db, wsB(), accountB);
    await expect(
      asUser(db, alice, (trx) => trx.insertInto('visual_tasks').values({ post_id: postB, workspace_id: wsA(), reason: 'redo' }).execute()),
    ).rejects.toThrow(/visual_tasks_post_id_workspace_id_fkey/);
  });
});

describe('budget d’images (VIS-05)', () => {
  it('vaut 30 images par mois par défaut et reste borné', async () => {
    const ws = await asSystem(db, (trx) => trx.selectFrom('workspaces').select('image_budget_monthly').where('id', '=', wsA()).executeTakeFirstOrThrow());
    expect(ws.image_budget_monthly).toBe(30);
    await expect(asSystem(db, (trx) => trx.updateTable('workspaces').set({ image_budget_monthly: -1 }).where('id', '=', wsA()).execute())).rejects.toThrow(
      /image_budget_monthly_check/,
    );
  });

  it('compte le remplissage d’un modèle à part', async () => {
    await asSystem(db, (trx) =>
      trx.insertInto('ai_usage').values({ workspace_id: wsA(), provider: 'anthropic', model: 'm', purpose: 'visual', kind: 'text' }).execute(),
    );
  });
});

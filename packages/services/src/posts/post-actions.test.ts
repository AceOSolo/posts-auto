import { type Database, asSystem } from '@posts-auto/db';
import {
  addMember,
  closeTestDatabase,
  createAccount,
  createOrganization,
  createPost,
  createUser,
  openTestDatabase,
} from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.js';
import { decidePost, editPostText, reschedulePost, retryPublication, withdrawPost } from './post-actions.js';

let db: Database;
let workspaceId: string;
let accountId: string;
const people = { holder: '', delegate: '', editor: '', admin: '', viewer: '', contributor: '', outsider: '' };

// Lundi 16 novembre 2026, 10h00 à Paris = 09:00 UTC. Créneau du post : mardi 12h00.
const NOW = new Date('2026-11-16T09:00:00Z');
const TUESDAY_NOON = new Date('2026-11-17T11:00:00Z');

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, workspaceId, people.holder, 'contributor');
  await addMember(db, workspaceId, people.delegate, 'editor');
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.admin, 'admin');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  await addMember(db, workspaceId, people.contributor, 'contributor');
  const other = await createOrganization(db);
  await addMember(db, other.workspaceIds[0] as string, people.outsider, 'admin');

  accountId = await createAccount(db, workspaceId, { holder_user_id: people.holder });
  await asSystem(db, (trx) =>
    trx.insertInto('account_delegates').values({ account_id: accountId, workspace_id: workspaceId, user_id: people.delegate }).execute(),
  );
});
afterAll(() => closeTestDatabase(db));

let slotOffset = 0;
/** Un post à valider, sur un créneau unique (les posts du même compte ne partagent pas un créneau). */
async function newPost(values: Parameters<typeof createPost>[3] = {}) {
  slotOffset += 1;
  return createPost(db, workspaceId, accountId, {
    scheduled_at: new Date(TUESDAY_NOON.getTime() + slotOffset * 7 * 24 * 3_600_000),
    week_start: '2026-11-16',
    ...values,
  });
}

const row = (id: string) => asSystem(db, (trx) => trx.selectFrom('posts').selectAll().where('id', '=', id).executeTakeFirstOrThrow());

describe('décision du titulaire ou de son délégué (VAL-02, ROL-01)', () => {
  it('le titulaire valide : décision enregistrée, historique et journal d’audit', async () => {
    const postId = await newPost();
    const outcome = await decidePost(db, people.holder, postId, { type: 'validate' }, NOW);
    expect(outcome).toMatchObject({ status: 'valide', departsNow: false });
    expect(await row(postId)).toMatchObject({ status: 'valide', decided_by: people.holder, decided_as_delegate: false });
    const audit = await asSystem(db, (trx) =>
      trx.selectFrom('audit_log').select(['action', 'actor_user_id']).where('entity_id', '=', postId).executeTakeFirstOrThrow(),
    );
    expect(audit).toEqual({ action: 'post.validate', actor_user_id: people.holder });
  });

  it('un délégué valide : la décision est marquée comme délégation', async () => {
    const postId = await newPost();
    await decidePost(db, people.delegate, postId, { type: 'validate' }, NOW);
    expect(await row(postId)).toMatchObject({ decided_by: people.delegate, decided_as_delegate: true });
  });

  it('un éditeur ou un admin non délégué ne peut pas valider', async () => {
    const postId = await newPost();
    for (const who of [people.editor, people.admin]) {
      await expect(decidePost(db, who, postId, { type: 'validate' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('une personne d’un autre client ne trouve pas le post (REC-01)', async () => {
    const postId = await newPost();
    await expect(decidePost(db, people.outsider, postId, { type: 'validate' }, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuse la validation tant qu’un marqueur bloquant reste dans le texte (VAL-03)', async () => {
    const postId = await newPost({ body: 'Rendez-vous le [À COMPLÉTER : date].' });
    await expect(decidePost(db, people.holder, postId, { type: 'validate' }, NOW)).rejects.toMatchObject({
      code: 'blocking_markers',
    });
  });

  it('exige une note pour demander une modification, et l’enregistre', async () => {
    const postId = await newPost();
    await expect(decidePost(db, people.holder, postId, { type: 'requestChanges', note: ' ' }, NOW)).rejects.toBeInstanceOf(RefusedError);
    await decidePost(db, people.holder, postId, { type: 'requestChanges', note: 'Raccourcir' }, NOW);
    expect(await row(postId)).toMatchObject({ status: 'modif', decision_note: 'Raccourcir' });
  });

  it('validé 10 minutes après son créneau : départ immédiat (RÈG-06, REC-06)', async () => {
    const postId = await createPost(db, workspaceId, accountId, { scheduled_at: TUESDAY_NOON, week_start: '2026-11-16' });
    const late = new Date(TUESDAY_NOON.getTime() + 10 * 60_000);
    const outcome = await decidePost(db, people.holder, postId, { type: 'validate' }, late);
    expect(outcome).toEqual({ status: 'valide', scheduledAt: late, departsNow: true });
    expect((await row(postId)).scheduled_at.toISOString()).toBe(late.toISOString());
  });
});

describe('correction du texte (révisions, RÈG-07)', () => {
  it('le titulaire corrige un post validé : nouvelle révision, le post reste validé', async () => {
    const postId = await newPost({ status: 'valide' });
    const outcome = await editPostText(db, people.holder, postId, 'Texte corrigé.', NOW);
    expect(outcome).toEqual({ revision: 2, status: 'valide', hasBlockingMarkers: false });
    const current = await asSystem(db, (trx) =>
      trx
        .selectFrom('posts as p')
        .innerJoin('post_versions as v', 'v.id', 'p.current_version_id')
        .select(['v.body', 'v.author_user_id'])
        .where('p.id', '=', postId)
        .executeTakeFirstOrThrow(),
    );
    expect(current).toEqual({ body: 'Texte corrigé.', author_user_id: people.holder });
  });

  it('un éditeur non délégué corrige un post validé : il repasse « à valider »', async () => {
    const postId = await newPost({ status: 'valide' });
    expect((await editPostText(db, people.editor, postId, 'Retouche.', NOW)).status).toBe('a_valider');
  });

  it('signale un marqueur bloquant ajouté par la correction', async () => {
    const postId = await newPost();
    expect((await editPostText(db, people.editor, postId, 'Le [À VÉRIFIER] chiffre.', NOW)).hasBlockingMarkers).toBe(true);
  });

  it('un lecteur ou un contributeur qui n’est pas titulaire ne peut pas corriger', async () => {
    const postId = await newPost();
    for (const who of [people.viewer, people.contributor]) {
      await expect(editPostText(db, who, postId, 'x', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('refuse un texte vide ou trop long, et la correction d’un post déjà publié', async () => {
    const postId = await newPost();
    await expect(editPostText(db, people.holder, postId, '  ', NOW)).rejects.toMatchObject({ code: 'empty_body' });
    await expect(editPostText(db, people.holder, postId, 'x'.repeat(3001), NOW)).rejects.toMatchObject({ code: 'body_too_long' });
    const published = await newPost({ status: 'publie', published_at: NOW, external_post_urn: 'urn:li:share:1' });
    await expect(editPostText(db, people.holder, published, 'x', NOW)).rejects.toMatchObject({ code: 'not_editable' });
  });
});

describe('changer le créneau à la main (RÈG-04)', () => {
  it('accepte un créneau libre et l’inscrit dans l’historique', async () => {
    const postId = await newPost();
    const at = new Date('2026-12-01T13:00:00Z'); // mardi 1er décembre, 14h00
    expect(await reschedulePost(db, people.holder, postId, at, NOW)).toEqual({ scheduledAt: at, outsideAllowedHours: false });
    expect(await row(postId)).toMatchObject({ week_start: '2026-11-30', reschedule_count: 0 });
  });

  it('accepte un créneau en soirée mais le signale', async () => {
    const postId = await newPost();
    const evening = new Date('2026-12-02T19:00:00Z'); // 20h00
    expect((await reschedulePost(db, people.editor, postId, evening, NOW)).outsideAllowedHours).toBe(true);
  });

  it('refuse un créneau dans moins de 15 minutes', async () => {
    const postId = await newPost();
    await expect(reschedulePost(db, people.holder, postId, new Date(NOW.getTime() + 5 * 60_000), NOW)).rejects.toMatchObject({
      code: 'too_soon',
    });
  });

  it('refuse un lecteur', async () => {
    const postId = await newPost();
    await expect(reschedulePost(db, people.viewer, postId, new Date('2026-12-03T13:00:00Z'), NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('retrait et nouvel essai', () => {
  it('le titulaire retire un post validé (VAL-08)', async () => {
    const postId = await newPost({ status: 'valide' });
    expect(await withdrawPost(db, people.holder, postId, NOW)).toBe('a_valider');
  });

  it('« réessayer » après une erreur remet le post en file avec 3 tentatives (PUB-04)', async () => {
    const postId = await newPost({ status: 'erreur' });
    expect(await retryPublication(db, people.holder, postId, NOW)).toBe('en_publication');
    expect(await row(postId)).toMatchObject({ publish_retries_left: 3, publish_lease_until: null });
    await expect(retryPublication(db, people.viewer, postId, NOW)).rejects.toBeInstanceOf(RefusedError); // plus en erreur
  });
});

import { FakeModel } from '@posts-auto/ai';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { assistPost, pendingHooks, proposeHooks, applyHook } from './assist.ts';

let db: Database;
let workspaceId: string;
let accountId: string;
let holder: string;
let contributor: string;
const NOW = new Date('2026-11-16T09:00:00Z');
const BODY = 'Première accroche d’origine.\n\nDeuxième paragraphe, qui donne les faits.\n\nEt vous ?';
let slot = 0;
const newPost = (values: Parameters<typeof createPost>[3] = {}) => createPost(db, workspaceId, accountId, { body: BODY, scheduled_at: new Date(Date.UTC(2026, 10, 17 + (slot += 1), 11)), ...values });
const versions = (postId: string) =>
  asSystem(db, (trx) => trx.selectFrom('post_versions').select(['revision', 'body', 'author_kind', 'author_user_id']).where('post_id', '=', postId).orderBy('revision').execute());

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  holder = await createUser(db, 'titulaire');
  contributor = await createUser(db, 'contributrice');
  await addMember(db, workspaceId, holder, 'contributor');
  await addMember(db, workspaceId, contributor, 'contributor');
  accountId = await createAccount(db, workspaceId, { display_name: 'JP', holder_user_id: holder });
});
afterAll(() => closeTestDatabase(db));

const short = `Accroche raccourcie.\n\n${'Le texte utile, plus court. '.repeat(25)}\n\nVotre avis ?`;

describe('retouches à la demande (GEN-08)', () => {
  it('« Raccourcir » : nouvelle révision vérifiée, écrite par l’IA à la demande du titulaire, hors quota', async () => {
    const postId = await newPost();
    const model = new FakeModel((call) => (call.purpose === 'verify' ? { issues: [] } : { body: short, summary: 's', sourcesUsed: [], missingInformation: [], ignoredInstructions: [] }));
    expect(await assistPost(db, model, holder, postId, 'raccourcir', NOW)).toEqual({ remaining: [] });
    expect(model.calls[0]?.task).toContain('Raccourcis le texte');
    expect(model.calls[0]?.task).toContain('Première accroche d’origine.');
    expect(model.calls[0]?.context).toContain('Compte : JP');
    expect((await versions(postId)).map((v) => [v.revision, v.author_kind, v.author_user_id])).toEqual([
      [1, 'ai', null],
      [2, 'ai', holder],
    ]);
    const usage = await asSystem(db, (trx) => trx.selectFrom('ai_usage').select(['purpose', 'counted_in_quota']).where('post_id', '=', postId).execute());
    expect(usage.every((u) => !u.counted_in_quota)).toBe(true);
    const history = await asSystem(db, (trx) => trx.selectFrom('post_status_history').select('reason').where('post_id', '=', postId).execute());
    expect(history.map((h) => h.reason)).toContain('Retouche demandée à l’IA : Raccourcis le texte d’environ un tiers, sans perdre l’information utile ni le lien éventuel.');
  });

  it('un problème restant après vérification est signalé par un marqueur et rendu à la page', async () => {
    const postId = await newPost();
    const issue = { kind: 'fait_non_source', excerpt: '87 %', explanation: 'Chiffre absent', blocking: true };
    const model = new FakeModel((call) => (call.purpose === 'verify' ? { issues: [issue] } : { body: short, summary: 's', sourcesUsed: [], missingInformation: [], ignoredInstructions: [] }));
    const result = await assistPost(db, model, holder, postId, 'ton_direct', NOW);
    expect(result.remaining).toHaveLength(1);
    expect((await versions(postId)).at(-1)?.body.startsWith('[À VÉRIFIER')).toBe(true);
  });

  it('réservé à qui peut corriger le post, sur un post à valider', async () => {
    const postId = await newPost();
    await expect(assistPost(db, new FakeModel(), contributor, postId, 'raccourcir', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    const validated = await newPost({ status: 'valide' });
    await expect(assistPost(db, new FakeModel(), holder, validated, 'raccourcir', NOW)).rejects.toMatchObject({ code: 'not_editable' });
    await expect(assistPost(db, new FakeModel(), holder, postId, 'traduire' as 'raccourcir', NOW)).rejects.toMatchObject({ code: 'retouche_inconnue' });
  });

  it('« Proposer 3 accroches » : propositions gardées une heure, l’accroche choisie remplace le premier paragraphe', async () => {
    const postId = await newPost();
    const model = new FakeModel(() => ({ hooks: ['Accroche A', 'Accroche B #hashtag', 'Accroche C', 'Accroche D'] }));
    expect(await proposeHooks(db, model, holder, postId, NOW)).toEqual(['Accroche A', 'Accroche B', 'Accroche C']);
    expect(await pendingHooks(db, holder, postId, new Date(NOW.getTime() + 30 * 60_000))).toEqual(['Accroche A', 'Accroche B', 'Accroche C']);
    expect(await pendingHooks(db, holder, postId, new Date(NOW.getTime() + 61 * 60_000))).toEqual([]);
    // Une autre personne ne voit pas les propositions faites au titulaire.
    expect(await pendingHooks(db, contributor, postId, NOW)).toEqual([]);

    await applyHook(db, holder, postId, 1, NOW);
    expect((await versions(postId)).at(-1)).toMatchObject({ revision: 2, author_kind: 'user', body: 'Accroche B\n\nDeuxième paragraphe, qui donne les faits.\n\nEt vous ?' });
    // Le texte a changé : les propositions ne s'appliquent plus.
    expect(await pendingHooks(db, holder, postId, NOW)).toEqual([]);
    await expect(applyHook(db, holder, postId, 0, NOW)).rejects.toMatchObject({ code: 'accroche_expiree' });
  });
});

describe('coût des retouches', () => {
  it('au plus 30 retouches par personne et par heure', async () => {
    const postId = await newPost();
    const model = new FakeModel(() => ({ hooks: ['A', 'B', 'C'] }));
    // Les demandes déjà faites dans ce fichier comptent aussi : on complète jusqu'à la limite.
    let refused: unknown = null;
    for (let i = 0; i < 40 && refused === null; i += 1) {
      refused = await proposeHooks(db, model, holder, postId, NOW).then(
        () => null,
        (error: unknown) => error,
      );
    }
    expect(refused).toMatchObject({ code: 'trop_de_retouches' });
    await expect(proposeHooks(db, model, holder, postId, new Date(NOW.getTime() + 3_601_000))).resolves.toHaveLength(3);
  });
});

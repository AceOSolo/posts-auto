import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { decidePost } from '../posts/post-actions.ts';
import { type ApiKeyContext, authenticateApiKey, createApiKey, revokeApiKey } from './api-keys.ts';
import { type MediaWriter, type SubmitPostInput, listAccounts, listPosts, submitPost } from './exchange.ts';

let db: Database;
const NOW = new Date('2026-11-16T09:00:00Z'); // lundi 10h00
const slot = (days: number, hourUtc = 11) => new Date(Date.UTC(2026, 10, 16 + days, hourUtc));

let wsA: string;
let wsB: string;
let accountA: string;
let accountB: string;
let holderA: string;
let keyA: string;
let ctxA: ApiKeyContext;
let ctxB: ApiKeyContext;
const written = new Map<string, Uint8Array>();
const media: MediaWriter = { write: async (key, bytes) => void written.set(key, bytes) };

beforeAll(async () => {
  db = await openTestDatabase();
  const a = await createOrganization(db);
  const b = await createOrganization(db);
  wsA = a.workspaceIds[0] as string;
  wsB = b.workspaceIds[0] as string;
  holderA = await createUser(db, 'jp');
  await addMember(db, wsA, holderA, 'contributor');
  accountA = await createAccount(db, wsA, { holder_user_id: holderA, display_name: 'JP' });
  accountB = await createAccount(db, wsB, { display_name: 'Autre client' });
  keyA = (await createApiKey(db, { workspaceId: wsA, name: 'Tâche Claude', scopes: ['posts:read', 'posts:write'] })).key;
  const keyB = (await createApiKey(db, { workspaceId: wsB, name: 'Autre', scopes: ['posts:read', 'posts:write'] })).key;
  ctxA = (await authenticateApiKey(db, keyA, NOW)) as ApiKeyContext;
  ctxB = (await authenticateApiKey(db, keyB, NOW)) as ApiKeyContext;
});
afterAll(() => closeTestDatabase(db));

let counter = 0;
const input = (overrides: Partial<SubmitPostInput> = {}): SubmitPostInput => {
  counter += 1;
  return { reference: `claude-2026-w47-${counter}`, accountId: accountA, scheduledAt: slot(counter), text: `Post n°${counter}`, origin: 'planning', ...overrides };
};

describe('clés d’API', () => {
  it('reconnaît une clé valide et son espace, met à jour sa dernière utilisation', async () => {
    expect(ctxA).toMatchObject({ workspaceId: wsA, scopes: new Set(['posts:read', 'posts:write']) });
    const row = await asSystem(db, (trx) => trx.selectFrom('api_keys').select(['last_used_at', 'key_hash']).where('id', '=', ctxA.keyId).executeTakeFirstOrThrow());
    expect(row.last_used_at?.toISOString()).toBe(NOW.toISOString());
    // Le secret suit « pa_<8 caractères>_ » ; il peut lui-même contenir « _ ».
    const secret = keyA.slice('pa_xxxxxxxx_'.length);
    expect(secret).toHaveLength(43);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key_hash).not.toContain(secret);
  });

  it('refuse une clé mal formée, inconnue ou révoquée', async () => {
    expect(await authenticateApiKey(db, 'n’importe quoi', NOW)).toBeNull();
    expect(await authenticateApiKey(db, `${keyA.slice(0, -1)}x`, NOW)).toBeNull();
    const { id, key } = await createApiKey(db, { workspaceId: wsA, name: 'Temporaire', scopes: ['posts:read'] });
    await revokeApiKey(db, id, NOW);
    expect(await authenticateApiKey(db, key, NOW)).toBeNull();
  });

  it('une clé en lecture seule ne peut pas déposer de post', async () => {
    const { key } = await createApiKey(db, { workspaceId: wsA, name: 'Lecture', scopes: ['posts:read'] });
    const ctx = (await authenticateApiKey(db, key, NOW)) as ApiKeyContext;
    await expect(submitPost(db, ctx, media, input(), NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('dépôt de posts', () => {
  it('crée un post « à valider », avec son historique et une trace dans le journal d’audit', async () => {
    const data = input({ text: 'Webinaire le [À COMPLÉTER : date].' });
    const { created, post } = await submitPost(db, ctxA, media, data, NOW);
    expect(created).toBe(true);
    expect(post).toMatchObject({ reference: data.reference, statut: 'a_valider', compte: accountA, version: 1, marqueurs_bloquants: true });
    const audit = await asSystem(db, (trx) => trx.selectFrom('audit_log').select(['actor_kind', 'action']).where('entity_id', '=', post.id).executeTakeFirstOrThrow());
    expect(audit).toEqual({ actor_kind: 'api_key', action: 'post.recu_api' });
  });

  it('renvoyer la même référence ne crée rien de plus (REC-13), même en parallèle', async () => {
    const data = input();
    const results = await Promise.all(Array.from({ length: 5 }, () => submitPost(db, ctxA, media, data, NOW)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.post.id)).size).toBe(1);
    const again = await submitPost(db, ctxA, media, data, NOW);
    expect(again).toMatchObject({ created: false, post: { id: results[0]?.post.id } });
  });

  it('stocke les images dans l’ordre, nettoyées, avec la mention IA', async () => {
    const pngA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const gif = new Uint8Array(Buffer.from('GIF89a-image'));
    const { post } = await submitPost(db, ctxA, media, input({ images: [{ bytes: gif, aiGenerated: true, altText: 'Scène' }, { bytes: pngA }] }), NOW);
    const rows = await asSystem(db, (trx) =>
      trx
        .selectFrom('post_media as pm')
        .innerJoin('media_assets as m', 'm.id', 'pm.asset_id')
        .select(['pm.position', 'm.mime', 'm.ai_generated', 'm.storage_key', 'pm.alt_text'])
        .where('pm.post_id', '=', post.id)
        .orderBy('pm.position')
        .execute(),
    );
    expect(rows.map((r) => [r.position, r.mime, r.ai_generated, r.alt_text])).toEqual([
      [1, 'image/gif', true, 'Scène'],
      [2, 'image/png', false, null],
    ]);
    expect(rows.every((r) => written.has(r.storage_key) && r.storage_key.startsWith(`${wsA}/posts/${post.id}/`))).toBe(true);
  });

  it('refuse une image qui n’en est pas une, un créneau trop proche ou déjà pris', async () => {
    await expect(submitPost(db, ctxA, media, input({ images: [{ bytes: new Uint8Array(Buffer.from('<svg>')), mime: 'image/png' }] }), NOW)).rejects.toMatchObject({
      code: 'image_unsupported',
    });
    await expect(submitPost(db, ctxA, media, input({ scheduledAt: new Date(NOW.getTime() + 5 * 60_000) }), NOW)).rejects.toMatchObject({ code: 'too_soon' });
    const taken = input();
    await submitPost(db, ctxA, media, taken, NOW);
    await expect(submitPost(db, ctxA, media, input({ scheduledAt: taken.scheduledAt }), NOW)).rejects.toMatchObject({ code: 'same_account_same_slot' });
  });
});

describe('reprises (GEN-03, GEN-07)', () => {
  it('après une demande de modification : la reprise remplace l’ancien post et porte la version 2', async () => {
    const original = input();
    const { post } = await submitPost(db, ctxA, media, original, NOW);
    await decidePost(db, holderA, post.id, { type: 'requestChanges', note: 'Plus court' }, NOW);

    const [seen] = (await listPosts(db, ctxA, { from: original.scheduledAt, to: original.scheduledAt })).filter((p) => p.id === post.id);
    expect(seen?.decision).toMatchObject({ note: 'Plus court', delegation: false });

    const rework = await submitPost(db, ctxA, media, input({ scheduledAt: original.scheduledAt, replaces: original.reference, text: 'Version courte' }), NOW);
    expect(rework.post).toMatchObject({ version: 2, remplace: original.reference, statut: 'a_valider' });
    const old = await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', post.id).executeTakeFirstOrThrow());
    expect(old.status).toBe('remplace');
  });

  it('un meilleur sujet remplace un post encore à valider, sans compter comme une reprise', async () => {
    const original = input();
    await submitPost(db, ctxA, media, original, NOW);
    const better = await submitPost(db, ctxA, media, input({ scheduledAt: original.scheduledAt, replaces: original.reference }), NOW);
    expect(better.post.version).toBe(1);
  });

  it('refuse de remplacer un post déjà validé', async () => {
    const original = input();
    const { post } = await submitPost(db, ctxA, media, original, NOW);
    await decidePost(db, holderA, post.id, { type: 'validate' }, NOW);
    await expect(submitPost(db, ctxA, media, input({ replaces: original.reference }), NOW)).rejects.toMatchObject({ code: 'not_replaceable' });
  });

  it('au-delà de 3 reprises, le post passe en traitement manuel', async () => {
    let current = input();
    let { post } = await submitPost(db, ctxA, media, current, NOW);
    for (let version = 2; version <= 4; version += 1) {
      await decidePost(db, holderA, post.id, { type: 'refuse', reason: 'ton_inadapte' }, NOW);
      const next = input({ scheduledAt: current.scheduledAt, replaces: current.reference });
      post = (await submitPost(db, ctxA, media, next, NOW)).post;
      current = next;
      expect(post.version).toBe(version);
    }
    await decidePost(db, holderA, post.id, { type: 'refuse', reason: 'ton_inadapte' }, NOW);
    await expect(submitPost(db, ctxA, media, input({ replaces: current.reference }), NOW)).rejects.toMatchObject({ code: 'too_many_reworks' });
  });
});

describe('étanchéité entre espaces', () => {
  it('une clé ne voit que les comptes et les posts de son espace', async () => {
    expect((await listAccounts(db, ctxB)).map((a) => a.id)).toEqual([accountB]);
    const postsB = await listPosts(db, ctxB, { from: slot(-30), to: slot(30) });
    expect(postsB.every((p) => p.compte === accountB)).toBe(true);
  });

  it('une clé ne peut ni utiliser le compte d’un autre espace, ni remplacer ses posts', async () => {
    await expect(submitPost(db, ctxB, media, input({ accountId: accountA }), NOW)).rejects.toMatchObject({ code: 'unknown_account' });
    const victim = input();
    await submitPost(db, ctxA, media, victim, NOW);
    await expect(submitPost(db, ctxB, media, input({ accountId: accountB, replaces: victim.reference }), NOW)).rejects.toMatchObject({
      code: 'unknown_replaced',
    });
  });

  it('refuse une période de plus de 62 jours', async () => {
    await expect(listPosts(db, ctxA, { from: slot(0), to: slot(70) })).rejects.toMatchObject({ code: 'window_too_large' });
  });
});

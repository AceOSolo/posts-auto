import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeLoginLink, requestLoginLink } from '../auth/auth.ts';
import { decidePost } from '../posts/post-actions.ts';
import { exportUserData } from './export.ts';
import { createZip, readZip } from './zip.ts';

let db: Database;
let jp: string;
let alice: string;
let jpEmail: string;
let aliceEmail: string;
const NOW = new Date('2026-11-16T09:00:00Z');
const images = new Map<string, Uint8Array>([['ws/photo.gif', new Uint8Array(Buffer.from('GIF89a-photo'))]]);
const media = { read: async (key: string) => images.get(key) ?? Promise.reject(new Error('absent')) };

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  const workspaceId = org.workspaceIds[0] as string;
  jp = await createUser(db, 'jp');
  alice = await createUser(db, 'alice');
  [jpEmail, aliceEmail] = await asSystem(db, async (trx) => [
    (await trx.selectFrom('users').select('email').where('id', '=', jp).executeTakeFirstOrThrow()).email,
    (await trx.selectFrom('users').select('email').where('id', '=', alice).executeTakeFirstOrThrow()).email,
  ]);
  await addMember(db, workspaceId, jp, 'contributor');
  await addMember(db, workspaceId, alice, 'editor');
  const account = await createAccount(db, workspaceId, { holder_user_id: jp, display_name: 'JP' });
  await asSystem(db, (trx) => trx.insertInto('account_delegates').values({ account_id: account, workspace_id: workspaceId, user_id: alice }).execute());

  const withPhoto = await createPost(db, workspaceId, account, { scheduled_at: new Date('2026-11-18T11:00:00Z'), body: 'Post avec photo' });
  await asSystem(db, async (trx) => {
    const asset = await trx
      .insertInto('media_assets')
      .values({ workspace_id: workspaceId, kind: 'upload', storage_key: 'ws/photo.gif', mime: 'image/gif' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: withPhoto, asset_id: asset.id, position: 1 }).execute();
  });
  // Alice, déléguée, demande une modification sur le post de JP, avec une note.
  await decidePost(db, alice, withPhoto, { type: 'requestChanges', note: 'Note confidentielle d’Alice' }, NOW);

  const link = await requestLoginLink(db, jpEmail, NOW);
  if (link.kind === 'send') await consumeLoginLink(db, link.token, NOW, { userAgent: 'Téléphone de JP' });
});
afterAll(() => closeTestDatabase(db));

describe('export des données personnelles (REC-12)', () => {
  it('produit une archive JSON + images, complète pour la personne', async () => {
    const { archive, fileName } = await exportUserData(db, media, jp, NOW);
    expect(fileName).toBe('mes-donnees-2026-11-16.zip');
    const entries = readZip(archive);
    expect(entries.map((e) => e.path)).toEqual(['mes-donnees.json', expect.stringMatching(/^images\/.+-1\.gif$/)]);
    expect(Buffer.from(entries[1]?.bytes ?? []).toString()).toBe('GIF89a-photo');

    const json = JSON.parse(Buffer.from(entries[0]?.bytes ?? []).toString('utf8'));
    expect(json.profil.email).toBe(jpEmail);
    expect(json.comptes_linkedin).toEqual([expect.objectContaining({ display_name: 'JP', kind: 'profile' })]);
    expect(json.posts_de_vos_comptes[0]).toMatchObject({ texte: 'Post avec photo', statut: 'modif' });
    expect(json.sessions).toEqual([expect.objectContaining({ user_agent: 'Téléphone de JP' })]);
  });

  it('ne révèle rien d’une autre personne : ni son nom, ni son adresse, ni sa note', async () => {
    const { archive } = await exportUserData(db, media, jp, NOW);
    const text = Buffer.from(readZip(archive)[0]?.bytes ?? []).toString('utf8');
    expect(text).not.toContain(aliceEmail);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('Note confidentielle');
    const json = JSON.parse(text);
    expect(json.posts_de_vos_comptes[0].decision).toEqual({ le: NOW.toISOString(), par: 'une autre personne de l’espace', note: null });
  });

  it('l’export d’Alice contient sa propre décision et sa note, sur le compte de JP', async () => {
    const json = JSON.parse(Buffer.from(readZip((await exportUserData(db, media, alice, NOW)).archive)[0]?.bytes ?? []).toString('utf8'));
    expect(json.vos_decisions_sur_d_autres_comptes).toEqual([expect.objectContaining({ display_name: 'JP', decision_note: 'Note confidentielle d’Alice', status: 'modif' })]);
    expect(json.posts_de_vos_comptes).toEqual([]);
  });

  it('trace l’export dans le journal d’audit', async () => {
    const rows = await asSystem(db, (trx) => trx.selectFrom('audit_log').select('action').where('actor_user_id', '=', jp).where('action', '=', 'rgpd.export').execute());
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('archive ZIP', () => {
  it('relit ce qu’elle a écrit, noms accentués compris, et détecte une altération', () => {
    const archive = createZip([{ path: 'données/été.txt', bytes: new Uint8Array(Buffer.from('contenu')) }], NOW);
    expect(readZip(archive)).toEqual([{ path: 'données/été.txt', bytes: Buffer.from('contenu') }]);
    const tampered = Buffer.from(archive);
    const firstDataByte = 30 + Buffer.byteLength('données/été.txt');
    tampered.writeUInt8(tampered.readUInt8(firstDataByte) ^ 0xff, firstDataByte);
    expect(() => readZip(tampered)).toThrow(/Somme de contrôle/);
  });

  it('refuse un chemin qui sortirait de l’archive', () => {
    expect(() => createZip([{ path: '../evasion.txt', bytes: new Uint8Array() }], NOW)).toThrow(/invalide/);
  });
});

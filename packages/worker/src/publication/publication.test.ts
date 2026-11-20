/**
 * File de publication sur une vraie base, avec un faux LinkedIn et une horloge contrôlée.
 * Couvre REC-05, REC-06, REC-08 et la garantie « jamais de double publication ».
 */
import { randomBytes } from 'node:crypto';
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
import { FakeLinkedIn, linkedInFailures } from '@posts-auto/linkedin';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryMediaStore } from '../media/media-store.ts';
import { TokenCipher } from '../secrets/token-cipher.ts';
import { type PublicationDeps, runPublicationTick } from './publication.ts';

let db: Database;
const cipher = new TokenCipher(new Map([['k1', randomBytes(32)]]), 'k1');

beforeAll(async () => {
  db = await openTestDatabase();
});
afterAll(() => closeTestDatabase(db));

// Mardi 17 novembre 2026, 12h00 à Paris = 11:00 UTC.
const NOON = new Date('2026-11-17T11:00:00Z');
const minutes = (n: number) => new Date(NOON.getTime() + n * 60_000);

interface Scene {
  readonly workspaceId: string;
  readonly orgId: string;
  readonly accountId: string;
  readonly holderId: string;
  readonly adminId: string;
  readonly linkedin: FakeLinkedIn;
  readonly media: MemoryMediaStore;
  readonly deps: (now: () => Date) => PublicationDeps;
}

/** Un espace, un compte LinkedIn connecté (jeton chiffré), son titulaire et un admin. */
async function scene(accountStatus: 'connected' | 'expired' = 'connected'): Promise<Scene> {
  const org = await createOrganization(db);
  const workspaceId = org.workspaceIds[0] as string;
  const holderId = await createUser(db, 'titulaire');
  const adminId = await createUser(db, 'admin');
  await addMember(db, workspaceId, holderId, 'contributor');
  await addMember(db, workspaceId, adminId, 'admin');
  const accountId = await createAccount(db, workspaceId, { holder_user_id: holderId, status: accountStatus });
  await asSystem(db, (trx) =>
    trx
      .insertInto('social_tokens')
      .values({
        account_id: accountId,
        workspace_id: workspaceId,
        oauth_client_id: 'app-a',
        access_token_enc: cipher.encrypt(`TOKEN-${accountId}`, accountId),
        scopes: ['w_member_social'],
        expires_at: minutes(60 * 24 * 50),
      })
      .execute(),
  );
  const linkedin = new FakeLinkedIn();
  const media = new MemoryMediaStore();
  return {
    workspaceId,
    orgId: org.orgId,
    accountId,
    holderId,
    adminId,
    linkedin,
    media,
    deps: (now) => ({ db, linkedin, media, cipher, clock: now }),
  };
}

async function validatedPost(s: Scene, values: Parameters<typeof createPost>[3] = {}): Promise<string> {
  return createPost(db, s.workspaceId, s.accountId, { status: 'valide', scheduled_at: NOON, ...values });
}

/** Ajoute des photos au post ; `order` donne la position de chaque photo (REC-05). */
async function attachPhotos(s: Scene, postId: string, order: number[]): Promise<void> {
  await asSystem(db, async (trx) => {
    for (const [index, position] of order.entries()) {
      const key = `${s.workspaceId}/${postId}/photo-${index + 1}.png`;
      await s.media.write(key, new Uint8Array([index + 1]));
      const asset = await trx
        .insertInto('media_assets')
        .values({ workspace_id: s.workspaceId, kind: 'upload', storage_key: key, mime: 'image/png' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('post_media')
        .values({ workspace_id: s.workspaceId, post_id: postId, asset_id: asset.id, position, alt_text: `Photo ${index + 1}` })
        .execute();
    }
  });
}

async function postRow(id: string) {
  return asSystem(db, (trx) => trx.selectFrom('posts').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
}

async function notificationsOf(postId: string, kind: string) {
  return asSystem(db, (trx) =>
    trx
      .selectFrom('notifications')
      .select(['user_id', 'channel'])
      .where('kind', '=', kind)
      .where(sql<string>`payload ->> 'postId'`, '=', postId)
      .execute(),
  );
}

describe('publication nominale', () => {
  it('publie à l’heure, avec les photos dans l’ordre choisi, et enregistre le lien (REC-05)', async () => {
    const s = await scene();
    const postId = await validatedPost(s, { body: 'Bonne nouvelle (enfin) !' });
    await attachPhotos(s, postId, [2, 3, 1]); // photo-3 en couverture, puis photo-1, puis photo-2

    const before = await runPublicationTick(s.deps(() => minutes(-1)));
    expect(before.started).not.toContain(postId);

    const report = await runPublicationTick(s.deps(() => minutes(0.5)));
    expect(report.started).toContain(postId);
    expect(report.published).toContain(postId);

    expect(s.linkedin.published).toHaveLength(1);
    const sent = s.linkedin.published[0];
    expect(sent?.accessToken).toBe(`TOKEN-${s.accountId}`);
    expect(sent?.request.text).toBe('Bonne nouvelle (enfin) !');
    expect(sent?.request.images.map((image) => image.bytes[0])).toEqual([3, 1, 2]);
    expect(sent?.request.images.map((image) => image.altText)).toEqual(['Photo 3', 'Photo 1', 'Photo 2']);

    const row = await postRow(postId);
    expect(row).toMatchObject({ status: 'publie', external_post_urn: sent?.postUrn, external_post_url: sent?.url, publish_lease_until: null });
    expect(row.published_at?.toISOString()).toBe(minutes(0.5).toISOString());

    const history = await asSystem(db, (trx) =>
      trx.selectFrom('post_status_history').select(['from_status', 'to_status']).where('post_id', '=', postId).orderBy('id').execute(),
    );
    expect(history).toEqual([
      { from_status: 'valide', to_status: 'en_publication' },
      { from_status: 'en_publication', to_status: 'publie' },
    ]);
    expect(await notificationsOf(postId, 'post_publie')).toEqual([{ user_id: s.holderId, channel: 'in_app' }]);
  });

  it('ne publie jamais deux fois, même avec deux processus en parallèle (PUB-03)', async () => {
    const s = await scene();
    const postId = await validatedPost(s);
    await Promise.all([runPublicationTick(s.deps(() => minutes(1))), runPublicationTick(s.deps(() => minutes(1)))]);
    await runPublicationTick(s.deps(() => minutes(60)));
    expect(s.linkedin.published).toHaveLength(1);
    expect((await postRow(postId)).status).toBe('publie');
  });
});

describe('pannes de LinkedIn (PUB-04, REC-08)', () => {
  it('coupure : 3 nouvelles tentatives à 1, 5 et 15 minutes, puis erreur, alerte, aucun doublon', async () => {
    const s = await scene();
    const postId = await validatedPost(s);
    s.linkedin.failNext(...Array.from({ length: 4 }, linkedInFailures.connectionRefused));

    const tick = (at: number) => runPublicationTick(s.deps(() => minutes(at)));
    expect((await tick(0)).retryScheduled).toContain(postId); // tentative 1
    expect((await tick(0.5)).retryScheduled).not.toContain(postId); // trop tôt
    expect((await tick(1)).retryScheduled).toContain(postId); // tentative 2
    expect((await tick(5.9)).retryScheduled).not.toContain(postId);
    expect((await tick(6)).retryScheduled).toContain(postId); // tentative 3
    expect((await tick(21)).failed).toContain(postId); // tentative 4 : erreur

    expect(s.linkedin.published).toHaveLength(0);
    const row = await postRow(postId);
    expect(row.status).toBe('erreur');
    expect(row.last_error).toMatch(/injoignable/);
    const attempts = await asSystem(db, (trx) =>
      trx.selectFrom('publish_attempts').select(['attempt', 'outcome']).where('post_id', '=', postId).orderBy('attempt').execute(),
    );
    expect(attempts).toEqual([1, 2, 3, 4].map((attempt) => ({ attempt, outcome: 'not_created' })));
    const alerts = await notificationsOf(postId, 'publication_erreur');
    expect(new Set(alerts.map((a) => a.user_id))).toEqual(new Set([s.holderId, s.adminId, (await orgOwner(s.orgId))]));
    expect(new Set(alerts.map((a) => a.channel))).toEqual(new Set(['email', 'in_app']));
  });

  it('se rétablit après un échec passager et publie une seule fois', async () => {
    const s = await scene();
    const postId = await validatedPost(s);
    s.linkedin.failNext(linkedInFailures.serviceUnavailable());
    await runPublicationTick(s.deps(() => minutes(0)));
    const report = await runPublicationTick(s.deps(() => minutes(1)));
    expect(report.published).toContain(postId);
    expect(s.linkedin.published).toHaveLength(1);
  });

  it('issue incertaine (post créé, réponse perdue) : erreur, jamais de nouvel essai automatique', async () => {
    const s = await scene();
    const postId = await validatedPost(s);
    s.linkedin.failNext(linkedInFailures.createdThenLost());
    const report = await runPublicationTick(s.deps(() => minutes(0)));
    expect(report.uncertain).toContain(postId);
    for (const at of [1, 6, 21, 120]) await runPublicationTick(s.deps(() => minutes(at)));
    expect(s.linkedin.published).toHaveLength(1); // le seul envoi, celui dont la réponse s'est perdue
    const row = await postRow(postId);
    expect(row.status).toBe('erreur');
    expect(row.last_error).toMatch(/Vérifiez sur LinkedIn avant de réessayer/);
  });

  it('jeton révoqué : erreur immédiate, compte marqué expiré pour bloquer ses autres posts', async () => {
    const s = await scene();
    const postId = await validatedPost(s);
    s.linkedin.failNext(linkedInFailures.tokenRevoked());
    expect((await runPublicationTick(s.deps(() => minutes(0)))).failed).toContain(postId);
    expect((await postRow(postId)).last_error).toMatch(/reconnectez le compte/);
    const account = await asSystem(db, (trx) =>
      trx.selectFrom('social_accounts').select('status').where('id', '=', s.accountId).executeTakeFirstOrThrow(),
    );
    expect(account.status).toBe('expired');
  });

  it('envoi interrompu (processus arrêté en pleine publication) : issue incertaine à l’expiration du verrou', async () => {
    const s = await scene();
    const postId = await validatedPost(s);
    // État laissé par un processus mort : en cours d'envoi, tentative non terminée, verrou expiré.
    await asSystem(db, async (trx) => {
      await trx
        .updateTable('posts')
        .set({ status: 'en_publication', publish_lease_until: minutes(-1), next_publish_attempt_at: null })
        .where('id', '=', postId)
        .execute();
      await trx
        .insertInto('publish_attempts')
        .values({ workspace_id: s.workspaceId, post_id: postId, attempt: 1, idempotency_key: `${postId}:1`, started_at: minutes(-16) })
        .execute();
    });
    const report = await runPublicationTick(s.deps(() => minutes(0)));
    expect(report.uncertain).toContain(postId);
    expect(s.linkedin.published).toHaveLength(0);
    expect((await postRow(postId)).status).toBe('erreur');
  });

  it('jeton absent : erreur sans appel à LinkedIn', async () => {
    const s = await scene();
    const postId = await validatedPost(s);
    await asSystem(db, (trx) => trx.deleteFrom('social_tokens').where('account_id', '=', s.accountId).execute());
    expect((await runPublicationTick(s.deps(() => minutes(0)))).failed).toContain(postId);
    expect(s.linkedin.published).toHaveLength(0);
  });
});

describe('conditions de départ (RÈG-05, RÈG-06, RÈG-11, RÈG-22, FAC-06)', () => {
  it('un marqueur bloquant réapparu renvoie le post en validation', async () => {
    const s = await scene();
    const postId = await validatedPost(s, { body: 'Rendez-vous le [À COMPLÉTER : date].' });
    expect((await runPublicationTick(s.deps(() => minutes(0)))).withdrawn).toContain(postId);
    expect((await postRow(postId)).status).toBe('a_valider');
    expect(s.linkedin.published).toHaveLength(0);
  });

  it('compte déconnecté : le post reste validé et ne part pas (RÈG-22)', async () => {
    const s = await scene('expired');
    const postId = await validatedPost(s);
    const report = await runPublicationTick(s.deps(() => minutes(0)));
    expect(report.started).not.toContain(postId);
    expect((await postRow(postId)).status).toBe('valide');
  });

  it('abonnement suspendu : rien ne part (FAC-06)', async () => {
    const s = await scene();
    const postId = await validatedPost(s);
    await asSystem(db, (trx) => trx.updateTable('organizations').set({ status: 'suspended' }).where('id', '=', s.orgId).execute());
    await runPublicationTick(s.deps(() => minutes(0)));
    expect((await postRow(postId)).status).toBe('valide');
  });

  it('validé la semaine précédente : prend un nouveau créneau au lieu de partir aussitôt (RÈG-06)', async () => {
    const s = await scene();
    const postId = await validatedPost(s, { scheduled_at: minutes(-7 * 24 * 60), week_start: '2026-11-09' });
    const report = await runPublicationTick(s.deps(() => minutes(10))); // mardi 12h10
    expect(report.moved).toContain(postId);
    const row = await postRow(postId);
    expect(row.status).toBe('valide');
    expect(row.scheduled_at.toISOString()).toBe(minutes(30).toISOString()); // 12h30, grille de 30 min
    expect(row.week_start).toBe('2026-11-16');
  });

  it('événement passé : abandon plutôt qu’une publication hors de propos (RÈG-11)', async () => {
    const s = await scene();
    const postId = await validatedPost(s, { must_publish_by: minutes(-1) });
    expect((await runPublicationTick(s.deps(() => minutes(0)))).abandoned).toContain(postId);
    expect((await postRow(postId)).status).toBe('abandonne');
  });
});

async function orgOwner(orgId: string): Promise<string> {
  const row = await asSystem(db, (trx) =>
    trx.selectFrom('org_members').select('user_id').where('org_id', '=', orgId).where('role', '=', 'owner').executeTakeFirstOrThrow(),
  );
  return row.user_id;
}

describe('publication manuelle (PUB-09)', () => {
  it('au créneau, le post part par e-mail au titulaire, même sans connexion valable, sans appel à LinkedIn', async () => {
    const s = await scene('expired');
    await asSystem(db, (trx) => trx.updateTable('social_accounts').set({ publish_mode: 'manual' }).where('id', '=', s.accountId).execute());
    const postId = await validatedPost(s);
    await attachPhotos(s, postId, [1, 2]);
    const report = await runPublicationTick(s.deps(() => minutes(1)));
    expect(report.manual).toEqual([postId]);
    expect(s.linkedin.published).toHaveLength(0);
    expect(await postRow(postId)).toMatchObject({ status: 'publie', published_manually: true, external_post_url: null });
    const sent = await notificationsOf(postId, 'publication_manuelle');
    expect(sent.map((n) => n.channel).sort()).toEqual(['email', 'in_app']);
    expect(sent[0]?.user_id).toBe(s.holderId);
    // Une seule fois : le post a quitté la file.
    expect((await runPublicationTick(s.deps(() => minutes(2)))).manual).toEqual([]);
  });
});

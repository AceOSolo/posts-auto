import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors.ts';
import { exportPosts, workspaceDashboard } from './dashboard.ts';

let db: Database;
let workspaceId: string;
let viewer: string;
let outsider: string;
let holderAccount: string;
let page: string;
// Mercredi 18 novembre 2026 : semaine du 16.
const NOW = new Date('2026-11-18T09:00:00Z');
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  const holder = await createUser(db, 'titulaire');
  viewer = await createUser(db, 'direction');
  outsider = await createUser(db, 'autre');
  await addMember(db, workspaceId, holder, 'contributor');
  await addMember(db, workspaceId, viewer, 'viewer');
  await asSystem(db, (trx) => trx.updateTable('users').set({ full_name: 'Jean Titulaire' }).where('id', '=', holder).execute());
  holderAccount = await createAccount(db, workspaceId, { display_name: 'Jean', holder_user_id: holder });
  page = await createAccount(db, workspaceId, { display_name: 'Entreprise', kind: 'page' });
  await createAccount(db, workspaceId, { display_name: 'Ancien', status: 'expired' });

  const week = { week_start: '2026-11-16' };
  await createPost(db, workspaceId, holderAccount, { ...week, scheduled_at: at('2026-11-19T11:00:00Z') });
  await createPost(db, workspaceId, holderAccount, { ...week, scheduled_at: at('2026-11-20T11:00:00Z') });
  await createPost(db, workspaceId, page, { ...week, scheduled_at: at('2026-11-19T08:00:00Z') });
  await createPost(db, workspaceId, page, { ...week, status: 'valide', scheduled_at: at('2026-11-18T15:00:00Z') });
  await createPost(db, workspaceId, holderAccount, { ...week, status: 'erreur', scheduled_at: at('2026-11-18T08:00:00Z'), last_error: 'LinkedIn indisponible' });
  await createPost(db, workspaceId, holderAccount, { ...week, status: 'remplace', scheduled_at: at('2026-11-17T08:00:00Z') });
  const published = await createPost(db, workspaceId, page, {
    week_start: '2026-11-09',
    status: 'publie',
    scheduled_at: at('2026-11-10T11:00:00Z'),
    published_at: at('2026-11-10T11:00:04Z'),
    external_post_url: 'https://www.linkedin.com/feed/update/urn:li:share:1',
    external_post_urn: 'urn:li:share:1',
  });
  await asSystem(db, async (trx) => {
    const asset = await trx
      .insertInto('media_assets')
      .values({ workspace_id: workspaceId, kind: 'rendered', ai_generated: true, storage_key: `t/${published}.png`, mime: 'image/png', render_content: '{}' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('post_media').values({ workspace_id: workspaceId, post_id: published, asset_id: asset.id, position: 1 }).execute();
  });
});
afterAll(() => closeTestDatabase(db));

describe('tableau de bord (SUI-01, SUI-02)', () => {
  it('semaine par statut, attentes par titulaire, prochains départs, erreurs, comptes à reconnecter', async () => {
    const dashboard = await workspaceDashboard(db, viewer, workspaceId, NOW);
    expect(dashboard.weekStart).toBe('2026-11-16');
    expect(dashboard.byStatus).toEqual({ a_valider: 3, valide: 1, erreur: 1 });
    expect(dashboard.pendingByHolder).toEqual([
      { holder: 'Entreprise (page, validateurs délégués)', count: 1, nextAt: at('2026-11-19T08:00:00Z') },
      { holder: 'Jean Titulaire', count: 2, nextAt: at('2026-11-19T11:00:00Z') },
    ]);
    expect(dashboard.nextDepartures.map((p) => p.accountName)).toEqual(['Entreprise']);
    expect(dashboard.errors).toEqual([expect.objectContaining({ accountName: 'Jean', lastError: 'LinkedIn indisponible' })]);
    expect(dashboard.accountsToReconnect.map((a) => a.name)).toEqual(['Ancien']);
    expect(dashboard.tracking.map((t) => t.accountName).sort()).toEqual(['Entreprise', 'Jean']);
    expect(dashboard.tracking.find((t) => t.accountName === 'Entreprise')?.weeks.find((w) => w.weekStart === '2026-11-09')).toMatchObject({ published: 1, onTime: 1 });
  });

  it('réservé aux membres de l’espace', async () => {
    await expect(workspaceDashboard(db, outsider, workspaceId, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(exportPosts(db, outsider, workspaceId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('export CSV des posts (SUI-06)', () => {
  it('tous les posts sauf les remplacés, avec images et lien LinkedIn', async () => {
    const { rows } = await exportPosts(db, viewer, workspaceId);
    expect(rows).toHaveLength(6);
    expect(rows.some((r) => r.status === 'remplace')).toBe(false);
    expect(rows[0]).toMatchObject({ accountName: 'Entreprise', accountKind: 'page', status: 'publie', images: 1, aiImage: true, url: 'https://www.linkedin.com/feed/update/urn:li:share:1' });
  });
});

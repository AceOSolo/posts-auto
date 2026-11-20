import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { AVATAR_CONSENT_VERSION, accountAvatar, declareAvatar, revokeAvatar } from './avatars.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const NOW = new Date('2026-11-20T10:00:00Z');
let db: Database;
let holder: string;
let admin: string;
let accountId: string;
let workspaceId: string;
const media = { write: async () => undefined };

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  holder = await createUser(db, 'titulaire-avatar');
  admin = await createUser(db, 'admin-avatar');
  await addMember(db, workspaceId, holder, 'contributor');
  await addMember(db, workspaceId, admin, 'admin');
  accountId = await createAccount(db, workspaceId, { holder_user_id: holder, kind: 'profile' });
});
afterAll(() => closeTestDatabase(db));

describe('avatar de marque (VIS-06)', () => {
  it('déclaré par le titulaire seulement, avec consentement ; hors médiathèque ; retiré par un administrateur', async () => {
    await expect(declareAvatar(db, media, admin, accountId, { bytes: new Uint8Array(PNG), consent: true }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(declareAvatar(db, media, holder, accountId, { bytes: new Uint8Array(PNG), consent: false }, NOW)).rejects.toMatchObject({ code: 'consentement_requis' });
    const assetId = await declareAvatar(db, media, holder, accountId, { bytes: new Uint8Array(PNG), consent: true, ip: '203.0.113.5' }, NOW);
    expect(await accountAvatar(db, holder, accountId)).toMatchObject({ assetId, consentVersion: AVATAR_CONSENT_VERSION });
    const asset = await asSystem(db, (trx) => trx.selectFrom('media_assets').select(['in_library', 'ai_generated']).where('id', '=', assetId).executeTakeFirstOrThrow());
    expect(asset).toEqual({ in_library: false, ai_generated: true });
    const consent = await asSystem(db, (trx) => trx.selectFrom('account_avatars').select(['consented_by', 'consent_ip', 'consent_text']).where('account_id', '=', accountId).executeTakeFirstOrThrow());
    expect(consent).toMatchObject({ consented_by: holder, consent_ip: '203.0.113.5', consent_text: expect.stringContaining('mon propre compte') });
    await revokeAvatar(db, admin, accountId, NOW);
    expect(await accountAvatar(db, holder, accountId)).toBeNull();
  });
});

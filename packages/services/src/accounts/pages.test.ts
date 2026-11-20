import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { FakeLinkedInOAuth, FakeLinkedInPages, PAGE_SCOPES, PROFILE_SCOPES } from '@posts-auto/linkedin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { type TokenCrypto, confirmPageConnection, pendingPageConnection, startPageConnection } from './pages.ts';

let db: Database;
let wsA: string;
let wsB: string;
let admin: string;
let otherAdmin: string;
let contributor: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const oauth = new FakeLinkedInOAuth('http://localhost/retour');
const pages = new FakeLinkedInPages();
/** Chiffrement de test, réversible et lié à son destinataire. */
const cipher: TokenCrypto = {
  encrypt: (plaintext, boundTo) => Buffer.from(`${boundTo}|${plaintext}`),
  decrypt: (payload, boundTo) => {
    const [bound, ...rest] = Buffer.from(payload).toString().split('|');
    if (bound !== boundTo) throw new Error('lié à un autre destinataire');
    return rest.join('|');
  },
};
const codeFor = (state: string, scopes: readonly string[] = PAGE_SCOPES) => new URL(oauth.authorizationUrl(state, scopes)).searchParams.get('code') as string;

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db, { workspaces: 2 });
  wsA = org.workspaceIds[0] as string;
  wsB = org.workspaceIds[1] as string;
  admin = await createUser(db, 'admin');
  otherAdmin = await createUser(db, 'admin-b');
  contributor = await createUser(db, 'contributrice');
  await addMember(db, wsA, admin, 'admin');
  await addMember(db, wsB, otherAdmin, 'admin');
  await addMember(db, wsA, contributor, 'contributor');
});
afterAll(() => closeTestDatabase(db));

describe('pages d’entreprise (LNK-02)', () => {
  it('liste les pages administrées, puis ajoute celles cochées avec leur jeton', async () => {
    const pendingId = await startPageConnection(db, { oauth, pages, cipher }, { userId: admin, workspaceId: wsA, code: codeFor('etat-pages-1') }, NOW);
    const choices = await pendingPageConnection(db, admin, wsA, pendingId, NOW);
    expect(choices).toHaveLength(2);
    expect(choices?.every((c) => !c.inWorkspace && !c.elsewhere)).toBe(true);

    const first = choices?.[0]?.urn as string;
    expect(await confirmPageConnection(db, cipher, { userId: admin, workspaceId: wsA, pendingId, urns: [first] }, NOW)).toBe(1);
    const account = await asSystem(db, (trx) =>
      trx
        .selectFrom('social_accounts as a')
        .innerJoin('social_tokens as t', 't.account_id', 'a.id')
        .select(['a.id', 'a.kind', 'a.display_name', 'a.holder_user_id', 'a.profile_url', 't.access_token_enc', 't.scopes', 't.connected_by'])
        .where('a.external_urn', '=', first)
        .executeTakeFirstOrThrow(),
    );
    expect(account).toMatchObject({ kind: 'page', display_name: 'Page de démonstration', holder_user_id: null, profile_url: 'https://www.linkedin.com/company/page-demo/', connected_by: admin });
    expect(account.scopes).toContain('w_organization_social');
    // Le jeton est chiffré pour ce compte, pas pour l'attente.
    expect(cipher.decrypt(account.access_token_enc, account.id)).toMatch(/^token-fake-p-/);
    const consent = await asSystem(db, (trx) => trx.selectFrom('account_consents').select('kind').where('account_id', '=', account.id).execute());
    expect(consent).toEqual([{ kind: 'publish' }]);
    // L'attente est effacée après le choix.
    expect(await pendingPageConnection(db, admin, wsA, pendingId, NOW)).toBeNull();
  });

  it('une page déjà dans l’espace se reconnecte ; une page d’un autre espace est refusée (LNK-06)', async () => {
    const again = await startPageConnection(db, { oauth, pages, cipher }, { userId: admin, workspaceId: wsA, code: codeFor('etat-pages-1') }, NOW);
    const choices = (await pendingPageConnection(db, admin, wsA, again, NOW)) ?? [];
    expect(choices.map((c) => c.inWorkspace)).toEqual([true, false]);
    expect(await confirmPageConnection(db, cipher, { userId: admin, workspaceId: wsA, pendingId: again, urns: choices.map((c) => c.urn) }, NOW)).toBe(2);
    const count = await asSystem(db, (trx) => trx.selectFrom('social_accounts').select('id').where('workspace_id', '=', wsA).where('kind', '=', 'page').execute());
    expect(count).toHaveLength(2);

    const inB = await startPageConnection(db, { oauth, pages, cipher }, { userId: otherAdmin, workspaceId: wsB, code: codeFor('etat-pages-1') }, NOW);
    const offered = (await pendingPageConnection(db, otherAdmin, wsB, inB, NOW)) ?? [];
    expect(offered.every((c) => c.elsewhere)).toBe(true);
    await expect(confirmPageConnection(db, cipher, { userId: otherAdmin, workspaceId: wsB, pendingId: inB, urns: [offered[0]?.urn as string] }, NOW)).rejects.toMatchObject({
      code: 'account_in_other_workspace',
    });
  });

  it('refuse sans la permission de publier pour les pages, et à qui ne gère pas l’espace', async () => {
    await expect(startPageConnection(db, { oauth, pages, cipher }, { userId: admin, workspaceId: wsA, code: codeFor('profil', PROFILE_SCOPES) }, NOW)).rejects.toMatchObject({
      code: 'publication_pages_non_autorisee',
    });
    await expect(startPageConnection(db, { oauth, pages, cipher }, { userId: contributor, workspaceId: wsA, code: codeFor('x') }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('le choix expire après 15 minutes, et reste propre à la personne', async () => {
    const pendingId = await startPageConnection(db, { oauth, pages, cipher }, { userId: admin, workspaceId: wsA, code: codeFor('etat-pages-2') }, NOW);
    expect(await pendingPageConnection(db, admin, wsA, pendingId, new Date(NOW.getTime() + 16 * 60_000))).toBeNull();
    await expect(confirmPageConnection(db, cipher, { userId: admin, workspaceId: wsA, pendingId, urns: ['urn:li:organization:1'] }, new Date(NOW.getTime() + 16 * 60_000))).rejects.toMatchObject({
      code: 'connexion-expiree',
    });
  });
});

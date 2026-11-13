import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import type { LinkedInOAuth, MemberProfile, TokenSet } from '@posts-auto/linkedin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import { CONSENT_TEXT_VERSION, type TokenEncryptor, connectProfile, disconnectAccount, listWorkspaceAccounts } from './accounts.ts';

let db: Database;
let wsA: string;
let wsB: string;
const people = { jp: '', alice: '', admin: '', outsider: '' };
const NOW = new Date('2026-11-16T09:00:00Z');

/** LinkedIn simulé : chaque code donne l'identité choisie par le test. */
class StubOAuth implements LinkedInOAuth {
  readonly clientId = 'app-a';
  readonly identities = new Map<string, MemberProfile>();
  scopes: string[] = ['openid', 'profile', 'w_member_social'];
  authorizationUrl(): string {
    return 'https://linkedin.example/auth';
  }
  async exchangeCode(code: string, now: Date): Promise<TokenSet> {
    return { accessToken: `AT-${code}`, expiresAt: new Date(now.getTime() + 60 * 86_400_000), refreshToken: null, refreshExpiresAt: null, scopes: this.scopes };
  }
  async refresh(): Promise<TokenSet> {
    throw new Error('non utilisé');
  }
  async memberProfile(accessToken: string): Promise<MemberProfile> {
    const profile = this.identities.get(accessToken.replace(/^AT-/, ''));
    if (!profile) throw new Error('code inconnu');
    return profile;
  }
  as(code: string, sub: string, name: string): this {
    this.identities.set(code, { sub, urn: `urn:li:person:${sub}`, name, pictureUrl: null });
    return this;
  }
}

const cipher: TokenEncryptor = { encrypt: (plaintext, boundTo) => Buffer.from(`enc(${boundTo}):${plaintext}`) };
let oauth: StubOAuth;

beforeAll(async () => {
  db = await openTestDatabase();
  const a = await createOrganization(db);
  const b = await createOrganization(db);
  wsA = a.workspaceIds[0] as string;
  wsB = b.workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) people[name] = await createUser(db, name);
  await addMember(db, wsA, people.jp, 'contributor');
  await addMember(db, wsA, people.alice, 'editor');
  await addMember(db, wsA, people.admin, 'admin');
  await addMember(db, wsB, people.outsider, 'admin');
  oauth = new StubOAuth().as('jp-code', 'JP123', 'Jean-Pierre Martin').as('jp-again', 'JP123', 'J.-P. Martin').as('alice-code', 'AL456', 'Alice');
});
afterAll(() => closeTestDatabase(db));

describe('connexion d’un profil par son titulaire (LNK-01, LNK-09)', () => {
  it('crée le compte, chiffre le jeton lié au compte et enregistre les consentements', async () => {
    const result = await connectProfile(db, { oauth, cipher }, { userId: people.jp, workspaceId: wsA, code: 'jp-code', aiLearning: true, ip: '192.0.2.10' }, NOW);
    expect(result).toMatchObject({ displayName: 'Jean-Pierre Martin', reconnected: false });

    const stored = await asSystem(db, async (trx) => ({
      account: await trx.selectFrom('social_accounts').selectAll().where('id', '=', result.accountId).executeTakeFirstOrThrow(),
      token: await trx.selectFrom('social_tokens').selectAll().where('account_id', '=', result.accountId).executeTakeFirstOrThrow(),
      consents: await trx.selectFrom('account_consents').select(['kind', 'text_version']).where('account_id', '=', result.accountId).execute(),
    }));
    expect(stored.account).toMatchObject({ kind: 'profile', external_urn: 'urn:li:person:JP123', holder_user_id: people.jp, status: 'connected' });
    expect(Buffer.from(stored.token.access_token_enc).toString()).toBe(`enc(${result.accountId}):AT-jp-code`);
    expect(stored.token).toMatchObject({ oauth_client_id: 'app-a', connected_by: people.jp });
    expect(stored.consents.map((c) => c.kind).sort()).toEqual(['ai_learning', 'publish', 'store_profile']);
    expect(stored.consents.every((c) => c.text_version === CONSENT_TEXT_VERSION)).toBe(true);
  });

  it('une reconnexion met à jour le même compte et retire le consentement à l’apprentissage s’il est refusé', async () => {
    const result = await connectProfile(db, { oauth, cipher }, { userId: people.jp, workspaceId: wsA, code: 'jp-again', aiLearning: false }, NOW);
    expect(result).toMatchObject({ reconnected: true, displayName: 'J.-P. Martin' });
    const active = await asSystem(db, (trx) =>
      trx.selectFrom('account_consents').select('kind').where('account_id', '=', result.accountId).where('revoked_at', 'is', null).execute(),
    );
    expect(active.map((c) => c.kind).sort()).toEqual(['publish', 'store_profile']);
  });

  it('refuse un profil déjà connecté dans un autre espace (LNK-06)', async () => {
    await addMember(db, wsB, people.jp, 'contributor');
    await expect(connectProfile(db, { oauth, cipher }, { userId: people.jp, workspaceId: wsB, code: 'jp-code', aiLearning: false }, NOW)).rejects.toMatchObject({
      code: 'account_in_other_workspace',
    });
  });

  it('refuse la connexion dans un espace dont la personne n’est pas membre', async () => {
    await expect(connectProfile(db, { oauth, cipher }, { userId: people.outsider, workspaceId: wsA, code: 'alice-code', aiLearning: false }, NOW)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuse si la permission de publier n’a pas été accordée', async () => {
    const restricted = new StubOAuth().as('x', 'X1', 'X');
    restricted.scopes = ['openid', 'profile'];
    await expect(connectProfile(db, { oauth: restricted, cipher }, { userId: people.alice, workspaceId: wsA, code: 'x', aiLearning: false }, NOW)).rejects.toMatchObject({
      code: 'publication_non_autorisee',
    });
  });
});

describe('fiche des comptes (LNK-03) et déconnexion (LNK-05)', () => {
  it('liste les comptes de l’espace avec l’échéance de leur connexion', async () => {
    await connectProfile(db, { oauth, cipher }, { userId: people.alice, workspaceId: wsA, code: 'alice-code', aiLearning: false }, NOW);
    const accounts = await listWorkspaceAccounts(db, people.alice, wsA);
    const alice = accounts.find((a) => a.name === 'Alice');
    expect(alice).toMatchObject({ isMine: true, canDisconnect: true, status: 'connected' });
    expect(alice?.connectionExpiresAt?.toISOString()).toBe('2027-01-15T09:00:00.000Z');
    expect(accounts.find((a) => a.name === 'J.-P. Martin')).toMatchObject({ isMine: false, canDisconnect: false });
  });

  it('un éditeur ne peut pas déconnecter le profil d’un autre ; l’admin le peut', async () => {
    const [jp] = (await listWorkspaceAccounts(db, people.admin, wsA)).filter((a) => a.name === 'J.-P. Martin');
    await expect(disconnectAccount(db, people.alice, jp?.id as string, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(jp?.canDisconnect).toBe(true);
  });

  it('déconnecter supprime le jeton, révoque les consentements et renvoie les posts validés en validation', async () => {
    const [jp] = (await listWorkspaceAccounts(db, people.jp, wsA)).filter((a) => a.isMine);
    const accountId = jp?.id as string;
    const validated = await createPost(db, wsA, accountId, { status: 'valide', scheduled_at: new Date('2026-11-18T11:00:00Z') });

    await disconnectAccount(db, people.jp, accountId, NOW);

    const after = await asSystem(db, async (trx) => ({
      token: await trx.selectFrom('social_tokens').select('account_id').where('account_id', '=', accountId).executeTakeFirst(),
      account: await trx.selectFrom('social_accounts').select('status').where('id', '=', accountId).executeTakeFirstOrThrow(),
      consents: await trx.selectFrom('account_consents').select('id').where('account_id', '=', accountId).where('revoked_at', 'is', null).execute(),
      post: await trx.selectFrom('posts').select('status').where('id', '=', validated).executeTakeFirstOrThrow(),
    }));
    expect(after).toEqual({ token: undefined, account: { status: 'revoked' }, consents: [], post: { status: 'a_valider' } });
    expect((await listWorkspaceAccounts(db, people.jp, wsA)).some((a) => a.id === accountId)).toBe(false);
  });

  it('une fois révoqué ailleurs, le profil peut être connecté dans un autre espace', async () => {
    const result = await connectProfile(db, { oauth, cipher }, { userId: people.jp, workspaceId: wsB, code: 'jp-code', aiLearning: false }, NOW);
    expect(result.reconnected).toBe(false);
  });
});

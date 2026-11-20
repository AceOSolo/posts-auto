import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createOrganization, createUser, addMember, openTestDatabase } from '@posts-auto/db/testing';
import type { LinkedInOAuth, MemberProfile, TokenSet } from '@posts-auto/linkedin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenEncryptor, connectProfile } from '../accounts/accounts.ts';
import { confirmSignup, requestSignup } from '../onboarding/signup.ts';
import { TRIAL_MAX_POSTS, canConnectAccount, remainingTrialPosts, trialBanners, trialStateForWorkspace } from './trial.ts';

let db: Database;
let owner: string;
let workspaceId: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const cipher: TokenEncryptor = { encrypt: (plaintext, boundTo) => Buffer.from(`enc(${boundTo}):${plaintext}`) };

/** LinkedIn simulé : le code est l'identifiant du profil. */
const oauth: LinkedInOAuth = {
  clientId: 'app-a',
  authorizationUrl: () => 'https://linkedin.example/auth',
  exchangeCode: async (code: string, now: Date): Promise<TokenSet> => ({
    accessToken: `AT-${code}`,
    expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    refreshToken: null,
    refreshExpiresAt: null,
    scopes: ['openid', 'profile', 'w_member_social'],
  }),
  refresh: async () => {
    throw new Error('non utilisé');
  },
  memberProfile: async (token: string): Promise<MemberProfile> => {
    const sub = token.replace(/^AT-/, '');
    return { sub, urn: `urn:li:person:${sub}`, name: `Profil ${sub}`, pictureUrl: null };
  },
};
const connect = (code: string, now = NOW) => connectProfile(db, { oauth, cipher }, { userId: owner, workspaceId, code, aiLearning: false }, now);
const state = (now = NOW) => asSystem(db, (trx) => trialStateForWorkspace(trx, workspaceId, now));

beforeAll(async () => {
  db = await openTestDatabase();
  const request = await requestSignup(db, { email: 'essai@exemple.fr', fullName: 'Essai', orgName: 'Essai SARL', orgKind: 'entreprise' }, NOW);
  if (request.kind !== 'confirm') throw new Error(request.kind);
  const outcome = await confirmSignup(db, request.token, NOW);
  if (!outcome.ok) throw new Error('inscription');
  owner = outcome.session.userId;
  workspaceId = outcome.workspaceId;
});
afterAll(() => closeTestDatabase(db));

describe('essai gratuit (ONB-06)', () => {
  it('démarre à l’inscription : 14 jours, ni compte ni post', async () => {
    expect(await state()).toMatchObject({ onTrial: true, expired: false, daysLeft: 14, accounts: 0, posts: 0 });
    expect(await trialBanners(db, owner, NOW)).toEqual([expect.objectContaining({ orgName: 'Essai SARL', daysLeft: 14 })]);
  });

  it('trois comptes LinkedIn au plus ; une reconnexion reste possible', async () => {
    for (const code of ['p1', 'p2', 'p3']) await connect(code);
    expect((await state()).accounts).toBe(3);
    await expect(connect('p4')).rejects.toMatchObject({ code: 'essai_comptes' });
    expect((await connect('p2')).reconnected).toBe(true);
  });

  it('dix posts rédigés au plus ; les reprises ne comptent pas', async () => {
    await asSystem(db, (trx) =>
      trx
        .insertInto('ai_usage')
        .values([
          ...Array.from({ length: 7 }, () => ({ workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'write' as const, kind: 'text' as const, counted_in_quota: true })),
          { workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'rework' as const, kind: 'text' as const, counted_in_quota: false },
          { workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'image' as const, kind: 'image' as const, units: 1, counted_in_quota: true },
        ])
        .execute(),
    );
    expect(remainingTrialPosts(await state())).toBe(TRIAL_MAX_POSTS - 7);
  });

  it('à la fin de l’essai : plus de rédaction ni de nouveau compte', async () => {
    const after = new Date(NOW.getTime() + 15 * 86_400_000);
    const expired = await state(after);
    expect(expired).toMatchObject({ expired: true, daysLeft: 0 });
    expect(remainingTrialPosts(expired)).toBe(0);
    expect(canConnectAccount(expired)).toEqual({ ok: false, code: 'essai_termine' });
    await asSystem(db, (trx) => trx.updateTable('social_accounts').set({ status: 'revoked' }).where('workspace_id', '=', workspaceId).where('display_name', '=', 'Profil p1').execute());
    await expect(connect('p5', after)).rejects.toMatchObject({ code: 'essai_termine' });
  });

  it('une organisation hors essai (Secutop) n’a aucune limite ni bandeau', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    for (let i = 0; i < 4; i += 1) await createAccount(db, ws);
    const free = await asSystem(db, (trx) => trialStateForWorkspace(trx, ws, NOW));
    expect(free).toMatchObject({ onTrial: false, accounts: 4 });
    expect(remainingTrialPosts(free)).toBeNull();
    expect(canConnectAccount(free)).toEqual({ ok: true });
    const admin = await createUser(db, 'admin-secutop');
    await addMember(db, ws, admin, 'admin');
    expect(await trialBanners(db, admin, NOW)).toEqual([]);
  });
});

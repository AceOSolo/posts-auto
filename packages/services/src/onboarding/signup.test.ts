import { type Database, asSystem, asUser } from '@posts-auto/db';
import { closeTestDatabase, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeLoginLink, resolveSession } from '../auth/auth.ts';
import { SIGNUPS_PER_IP_PER_HOUR, TRIAL_DAYS, confirmSignup, pendingSignup, requestSignup } from './signup.ts';

let db: Database;
const NOW = new Date('2026-11-20T10:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const input = (email: string, extra: Partial<{ fullName: string; orgName: string; orgKind: string }> = {}) => ({
  email,
  fullName: 'Camille Martin',
  orgName: 'Prévention Plus',
  orgKind: 'entreprise',
  ...extra,
});
const userCount = (email: string) => asSystem(db, (trx) => trx.selectFrom('users').select('id').where('email', '=', email).execute());

beforeAll(async () => {
  db = await openTestDatabase();
});
afterAll(() => closeTestDatabase(db));

describe('inscription en libre-service (ONB-01, ONB-02, ONB-06)', () => {
  it('refuse un champ manquant ou invalide', async () => {
    expect(await requestSignup(db, input('pas-une-adresse'), NOW)).toEqual({ kind: 'invalid', field: 'email' });
    expect(await requestSignup(db, input('a@b.fr', { fullName: '  ' }), NOW)).toEqual({ kind: 'invalid', field: 'nom' });
    expect(await requestSignup(db, input('a@b.fr', { orgName: '' }), NOW)).toEqual({ kind: 'invalid', field: 'organisation' });
    expect(await requestSignup(db, input('a@b.fr', { orgKind: 'association' }), NOW)).toEqual({ kind: 'invalid', field: 'type' });
  });

  it('ne crée rien avant la confirmation ; le clic crée la personne, l’organisation, l’espace et l’essai', async () => {
    const request = await requestSignup(db, input('  Camille@Exemple.FR '), NOW, '203.0.113.7');
    expect(request).toMatchObject({ kind: 'confirm', email: 'camille@exemple.fr', fullName: 'Camille Martin' });
    if (request.kind !== 'confirm') throw new Error(request.kind);
    expect(await userCount('camille@exemple.fr')).toEqual([]);
    // La page de confirmation lit la demande sans la consommer.
    expect(await pendingSignup(db, request.token, later(5))).toEqual({ email: 'camille@exemple.fr', orgName: 'Prévention Plus', orgKind: 'entreprise' });

    const outcome = await confirmSignup(db, request.token, later(5), { userAgent: 'test' });
    if (!outcome.ok) throw new Error('refusé');
    expect(outcome.created).toBe(true);
    const created = await asSystem(db, async (trx) => {
      const user = await trx.selectFrom('users').select(['id', 'full_name']).where('email', '=', 'camille@exemple.fr').executeTakeFirstOrThrow();
      const org = await trx
        .selectFrom('org_members as m')
        .innerJoin('organizations as o', 'o.id', 'm.org_id')
        .select(['o.id', 'o.name', 'o.kind', 'o.trial_ends_at', 'm.role'])
        .where('m.user_id', '=', user.id)
        .executeTakeFirstOrThrow();
      const workspace = await trx.selectFrom('workspaces').select(['id', 'name', 'org_id']).where('id', '=', outcome.workspaceId).executeTakeFirstOrThrow();
      const member = await trx.selectFrom('workspace_members').select('role').where('workspace_id', '=', workspace.id).where('user_id', '=', user.id).executeTakeFirst();
      return { user, org, workspace, member };
    });
    expect(created.user.full_name).toBe('Camille Martin');
    expect(created.org).toMatchObject({ name: 'Prévention Plus', kind: 'entreprise', role: 'owner' });
    expect(created.org.trial_ends_at?.getTime()).toBe(later(5).getTime() + TRIAL_DAYS * 86_400_000);
    expect(created.workspace).toMatchObject({ name: 'Prévention Plus', org_id: created.org.id });
    expect(created.member?.role).toBe('admin');
    expect(await resolveSession(db, outcome.session.sessionToken, later(6))).toMatchObject({ userId: created.user.id });
    // La personne voit son espace (RLS).
    const visible = await asUser(db, created.user.id, (trx) => trx.selectFrom('workspaces').select('id').execute());
    expect(visible.map((w) => w.id)).toEqual([outcome.workspaceId]);

    // Lien à usage unique.
    expect(await confirmSignup(db, request.token, later(7))).toEqual({ ok: false });
    expect(await pendingSignup(db, request.token, later(7))).toBeNull();
  });

  it('une agence reçoit un premier espace « Premier client » à renommer', async () => {
    const request = await requestSignup(db, input('agence@exemple.fr', { orgName: 'Agence Lumière', orgKind: 'agence' }), NOW);
    if (request.kind !== 'confirm') throw new Error(request.kind);
    const outcome = await confirmSignup(db, request.token, NOW);
    if (!outcome.ok) throw new Error('refusé');
    const workspace = await asSystem(db, (trx) =>
      trx.selectFrom('workspaces as w').innerJoin('organizations as o', 'o.id', 'w.org_id').select(['w.name', 'o.kind']).where('w.id', '=', outcome.workspaceId).executeTakeFirstOrThrow(),
    );
    expect(workspace).toEqual({ name: 'Premier client', kind: 'agence' });
  });

  it('une adresse déjà inscrite reçoit un lien de connexion, pas une seconde organisation', async () => {
    await createUser(db, 'deja');
    const email = (await asSystem(db, (trx) => trx.selectFrom('users').select('email').where('email', 'like', 'deja%').executeTakeFirstOrThrow())).email;
    const request = await requestSignup(db, input(email), NOW);
    expect(request.kind).toBe('login');
    if (request.kind !== 'login') throw new Error(request.kind);
    expect((await consumeLoginLink(db, request.token, NOW)).ok).toBe(true);
  });

  it('deux demandes confirmées : la seconde connecte simplement la personne', async () => {
    const first = await requestSignup(db, input('double@exemple.fr'), NOW);
    const second = await requestSignup(db, input('double@exemple.fr'), NOW);
    if (first.kind !== 'confirm' || second.kind !== 'confirm') throw new Error('demande');
    const a = await confirmSignup(db, first.token, NOW);
    const b = await confirmSignup(db, second.token, NOW);
    expect(a).toMatchObject({ ok: true, created: true });
    expect(b).toMatchObject({ ok: true, created: false });
    if (a.ok && b.ok) expect(b.workspaceId).toBe(a.workspaceId);
    expect(await userCount('double@exemple.fr')).toHaveLength(1);
  });

  it('un lien expiré ne crée rien', async () => {
    const request = await requestSignup(db, input('tard@exemple.fr'), NOW);
    if (request.kind !== 'confirm') throw new Error(request.kind);
    expect(await confirmSignup(db, request.token, later(61))).toEqual({ ok: false });
    expect(await userCount('tard@exemple.fr')).toEqual([]);
  });

  it('limite les demandes par adresse et par adresse IP', async () => {
    for (let i = 0; i < 5; i += 1) expect((await requestSignup(db, input('presse@exemple.fr'), NOW)).kind).toBe('confirm');
    expect(await requestSignup(db, input('presse@exemple.fr'), NOW)).toEqual({ kind: 'rate_limited' });
    for (let i = 0; i < SIGNUPS_PER_IP_PER_HOUR; i += 1) expect((await requestSignup(db, input(`robot${i}@exemple.fr`), NOW, '198.51.100.9')).kind).toBe('confirm');
    expect(await requestSignup(db, input('robot-suivant@exemple.fr'), NOW, '198.51.100.9')).toEqual({ kind: 'rate_limited' });
    expect((await requestSignup(db, input('robot-suivant@exemple.fr'), later(61), '198.51.100.9')).kind).toBe('confirm');
  });

  it('les demandes d’inscription sont fermées à l’application web', async () => {
    const someone = await createUser(db, 'curieux');
    await expect(asUser(db, someone, (trx) => trx.selectFrom('signup_requests').select('email').execute())).rejects.toThrow(/permission denied/);
  });
});

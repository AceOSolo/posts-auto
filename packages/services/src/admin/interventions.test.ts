import { type Database, asSystem, asUser } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowanceForWorkspace, isUnpaidSuspended, workspaceNotBlockedByPayment } from '../billing/allowance.ts';
import { applyBillingEvent, purgeExpiredSuspensions } from '../billing/subscriptions.ts';
import { ForbiddenError } from '../errors.ts';
import { retryPublication } from '../posts/post-actions.ts';
import { type DemoNotifier, createDemoRequest, listDemoRequests, retryDemoForward, updateDemoRequest } from '../site/site.ts';
import { extendTrial, listFailedGenerations, listPublicationsInError, reactivateOrganization, relaunchGeneration, retryPublicationAsSupport, suspendOrganization } from './interventions.ts';
import { listOrganizations, organizationDetail } from './organizations.ts';

let db: Database;
let admin: string;
const NOW = new Date('2026-11-23T10:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

beforeAll(async () => {
  db = await openTestDatabase();
  admin = await createUser(db, 'editeur');
  await asSystem(db, async (trx) => {
    await trx.insertInto('platform_admins').values({ user_id: admin }).execute();
    await trx.insertInto('user_totp').values({ user_id: admin, secret_encrypted: Buffer.from('x'), confirmed_at: NOW }).execute();
  });
});
afterAll(() => closeTestDatabase(db));

const auditActions = async (orgId: string) =>
  asSystem(db, (trx) => trx.selectFrom('audit_log').select(['action', 'actor_kind', 'actor_user_id', 'details']).where('org_id', '=', orgId).orderBy('id').execute());

async function subscribe(orgId: string, eventId: string, status: 'active' | 'past_due' = 'active') {
  await asSystem(db, (trx) => trx.updateTable('plans').set({ stripe_price_monthly: 'price_interventions', price_monthly_cents: 3900 }).where('key', '=', 'essentiel').execute());
  await applyBillingEvent(
    db,
    { kind: 'subscription', eventId, orgId, customerId: `cus_${eventId}`, subscriptionId: `sub_${eventId}`, priceId: 'price_interventions', quantity: 1, status, interval: 'month', periodStart: NOW, periodEnd: days(30), cancelAtPeriodEnd: false },
    NOW,
  );
}

describe('accès', () => {
  it('toutes les interventions sont réservées à l’éditeur', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    await expect(extendTrial(db, org.ownerId, org.orgId, 7, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(suspendOrganization(db, org.ownerId, org.orgId, 'motif', NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reactivateOrganization(db, org.ownerId, org.orgId, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(relaunchGeneration(db, org.ownerId, ws, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(retryPublicationAsSupport(db, org.ownerId, ws, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listPublicationsInError(db, org.ownerId, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateDemoRequest(db, org.ownerId, ws, { status: 'contactee', note: '' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('prolongation de l’essai', () => {
  const trialOrg = async (endsAt: Date | null) => {
    const org = await createOrganization(db);
    await asSystem(db, (trx) => trx.updateTable('organizations').set({ trial_ends_at: endsAt }).where('id', '=', org.orgId).execute());
    return org;
  };

  it('part de la fin prévue, ou d’aujourd’hui si l’essai est terminé, et rouvre la rédaction', async () => {
    const running = await trialOrg(days(3));
    expect(await extendTrial(db, admin, running.orgId, 7, NOW)).toEqual(days(10));
    const over = await trialOrg(days(-5));
    const ws = over.workspaceIds[0] as string;
    expect((await asSystem(db, (trx) => allowanceForWorkspace(trx, ws, NOW))).mode).toBe('trial_over');
    expect(await extendTrial(db, admin, over.orgId, 7, NOW)).toEqual(days(7));
    expect((await asSystem(db, (trx) => allowanceForWorkspace(trx, ws, NOW))).mode).toBe('trial');
    expect(await auditActions(over.orgId)).toEqual([expect.objectContaining({ action: 'support.essai_prolonge', actor_kind: 'support', actor_user_id: admin })]);
  });

  it('refuse hors essai, au-delà des limites, et pour un abonné', async () => {
    const pilot = await trialOrg(null);
    await expect(extendTrial(db, admin, pilot.orgId, 7, NOW)).rejects.toMatchObject({ code: 'essai_non_prolongeable' });
    const trial = await trialOrg(days(40));
    await expect(extendTrial(db, admin, trial.orgId, 0, NOW)).rejects.toMatchObject({ code: 'duree_essai_invalide' });
    await expect(extendTrial(db, admin, trial.orgId, 61, NOW)).rejects.toMatchObject({ code: 'duree_essai_invalide' });
    await expect(extendTrial(db, admin, trial.orgId, 60, NOW)).rejects.toMatchObject({ code: 'essai_trop_long' });
    const subscribed = await trialOrg(days(3));
    await subscribe(subscribed.orgId, 'evt_int_trial');
    await expect(extendTrial(db, admin, subscribed.orgId, 7, NOW)).rejects.toMatchObject({ code: 'essai_non_prolongeable' });
    expect((await organizationDetail(db, admin, subscribed.orgId, NOW)).canExtendTrial).toBe(false);
  });
});

describe('suspension par l’éditeur', () => {
  it('arrête rédaction et publication, puis se lève', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    await expect(suspendOrganization(db, admin, org.orgId, ' x ', NOW)).rejects.toMatchObject({ code: 'motif_suspension_requis' });
    await suspendOrganization(db, admin, org.orgId, 'Usage contraire aux CGU', NOW);
    await expect(suspendOrganization(db, admin, org.orgId, 'Encore', NOW)).rejects.toMatchObject({ code: 'organisation_deja_suspendue' });
    expect(await asSystem(db, (trx) => allowanceForWorkspace(trx, ws, NOW))).toMatchObject({ mode: 'editor_suspended', canPublish: false, posts: { remaining: 0 }, images: { remaining: 0 } });
    expect((await organizationDetail(db, admin, org.orgId, NOW)).suspension).toMatchObject({ reason: 'Usage contraire aux CGU' });
    expect((await listOrganizations(db, admin, NOW)).find((o) => o.id === org.orgId)?.editorSuspended).toBe(true);
    await reactivateOrganization(db, admin, org.orgId, hours(1));
    await expect(reactivateOrganization(db, admin, org.orgId, hours(2))).rejects.toMatchObject({ code: 'organisation_non_suspendue' });
    expect((await asSystem(db, (trx) => allowanceForWorkspace(trx, ws, hours(2)))).canPublish).toBe(true);
    const actions = (await auditActions(org.orgId)).map((a) => a.action);
    expect(actions).toEqual(['support.organisation_suspendue', 'support.organisation_reactivee']);
  });

  it('n’est pas levée par un paiement Stripe et ne déclenche pas la purge', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    await subscribe(org.orgId, 'evt_int_susp', 'past_due');
    await suspendOrganization(db, admin, org.orgId, 'Contrôle en cours', NOW);
    await applyBillingEvent(db, { kind: 'payment_succeeded', eventId: 'evt_int_paid', subscriptionId: 'sub_evt_int_susp' }, NOW);
    expect((await asSystem(db, (trx) => allowanceForWorkspace(trx, ws, NOW))).mode).toBe('editor_suspended');
    await asSystem(db, (trx) => trx.updateTable('subscriptions').set({ status: 'past_due', past_due_since: days(-200) }).where('org_id', '=', org.orgId).execute());
    expect((await purgeExpiredSuspensions(db, NOW)).map((p) => p.orgId)).not.toContain(org.orgId);
    expect(await asSystem(db, (trx) => trx.selectFrom('organizations').select('id').where('id', '=', org.orgId).executeTakeFirst())).toBeDefined();
  });

  it('un membre voit la suspension, jamais son motif, et ne peut pas la lever', async () => {
    const org = await createOrganization(db);
    const other = await createOrganization(db);
    await suspendOrganization(db, admin, org.orgId, 'Motif interne', NOW);
    const seen = await asUser(db, org.ownerId, (trx) => trx.selectFrom('org_suspensions').select('org_id').where('lifted_at', 'is', null).execute());
    expect(seen).toEqual([{ org_id: org.orgId }]);
    expect(await asUser(db, other.ownerId, (trx) => trx.selectFrom('org_suspensions').select('org_id').execute())).toEqual([]);
    await expect(asUser(db, org.ownerId, (trx) => trx.selectFrom('org_suspensions').select('reason').execute())).rejects.toThrow(/permission/);
    await expect(asUser(db, org.ownerId, (trx) => trx.updateTable('org_suspensions').set({ lifted_at: NOW }).where('org_id', '=', org.orgId).execute())).rejects.toThrow(/permission/);
    expect(JSON.stringify(await auditActions(org.orgId))).not.toContain('Motif interne');
  });

  it('le client ne peut pas relancer une publication pendant la suspension', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    const holder = await createUser(db, 'titulaire');
    await addMember(db, ws, holder, 'contributor');
    const account = await createAccount(db, ws, { holder_user_id: holder, status: 'connected' });
    const post = await createPost(db, ws, account, { status: 'erreur', scheduled_at: hours(-1) });
    await suspendOrganization(db, admin, org.orgId, 'Contrôle en cours', NOW);
    await expect(retryPublication(db, holder, post, NOW)).rejects.toMatchObject({ code: 'organisation_suspendue' });
    await reactivateOrganization(db, admin, org.orgId, NOW);
    await expect(retryPublication(db, holder, post, NOW)).resolves.toBe('en_publication');
  });
});

describe('relance par le client', () => {
  async function clientPost(values: Parameters<typeof createPost>[3] = {}) {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    const holder = await createUser(db, 'titulaire');
    await addMember(db, ws, holder, 'contributor');
    const account = await createAccount(db, ws, { holder_user_id: holder, status: 'connected' });
    const post = await createPost(db, ws, account, { status: 'erreur', scheduled_at: hours(-1), ...values });
    return { org, ws, holder, post };
  }
  const setSub = (orgId: string, status: string, since: Date | null) =>
    asSystem(db, (trx) => trx.updateTable('subscriptions').set({ status, past_due_since: since }).where('org_id', '=', orgId).execute());

  it('est refusée pendant un impayé, reste possible avant J+14 et après le règlement', async () => {
    const { org, holder, post } = await clientPost();
    await subscribe(org.orgId, 'evt_client_retry', 'past_due');
    await setSub(org.orgId, 'past_due', days(-14));
    await expect(retryPublication(db, holder, post, NOW)).rejects.toMatchObject({ code: 'organisation_suspendue' });
    await setSub(org.orgId, 'past_due', days(-13));
    await expect(retryPublication(db, holder, post, NOW)).resolves.toBe('en_publication');
  });

  it('est refusée quand l’organisation est suspendue pour impayé', async () => {
    const { org, holder, post } = await clientPost();
    await asSystem(db, (trx) => trx.updateTable('organizations').set({ status: 'suspended' }).where('id', '=', org.orgId).execute());
    await expect(retryPublication(db, holder, post, NOW)).rejects.toMatchObject({ code: 'organisation_suspendue' });
  });

  it('est refusée après l’événement, et le post reste en erreur', async () => {
    const { holder, post } = await clientPost({ must_publish_by: hours(-1) });
    await expect(retryPublication(db, holder, post, NOW)).rejects.toMatchObject({ code: 'evenement_passe' });
    expect((await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', post).executeTakeFirstOrThrow())).status).toBe('erreur');
  });

  it('le filtre des tâches de fond suit la même règle que le calcul des droits', async () => {
    const { org, ws } = await clientPost();
    await subscribe(org.orgId, 'evt_filter_rule', 'active');
    const cases: [string, Date | null][] = [['active', null], ['past_due', days(-13)], ['past_due', days(-14)], ['unpaid', days(-1)], ['canceled', null], ['canceled', days(-1)], ['incomplete', null]];
    for (const [status, since] of cases) {
      await setSub(org.orgId, status, since);
      const free = await asSystem(db, (trx) => trx.selectFrom('workspaces as w').select('w.id').where('w.id', '=', ws).where(workspaceNotBlockedByPayment('w.id', NOW)).executeTakeFirst());
      expect([status, since, free !== undefined]).toEqual([status, since, !isUnpaidSuspended({ status, past_due_since: since }, NOW)]);
    }
  });
});

describe('relance d’une publication', () => {
  async function failedPost(outcome: 'not_created' | 'unknown' | null, values: Parameters<typeof createPost>[3] = {}, accountStatus: 'connected' | 'expired' = 'connected') {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    const account = await createAccount(db, ws, { status: accountStatus });
    const post = await createPost(db, ws, account, { status: 'erreur', scheduled_at: hours(-2), last_error: 'LinkedIn indisponible', ...values });
    if (outcome !== null) {
      await asSystem(db, (trx) => trx.insertInto('publish_attempts').values({ workspace_id: ws, post_id: post, attempt: 1, idempotency_key: `${post}:1`, started_at: hours(-2), finished_at: hours(-2), outcome }).execute());
    }
    return { org, ws, post };
  }

  it('relance un échec certain et le trace', async () => {
    const { org, post } = await failedPost('not_created');
    expect((await listPublicationsInError(db, admin, NOW)).find((p) => p.postId === post)).toMatchObject({ blockedBy: null, error: 'LinkedIn indisponible' });
    await retryPublicationAsSupport(db, admin, post, NOW);
    const row = await asSystem(db, (trx) => trx.selectFrom('posts').select(['status', 'publish_retries_left', 'next_publish_attempt_at', 'publish_lease_until']).where('id', '=', post).executeTakeFirstOrThrow());
    expect(row).toEqual({ status: 'en_publication', publish_retries_left: 3, next_publish_attempt_at: NOW, publish_lease_until: null });
    const history = await asSystem(db, (trx) => trx.selectFrom('post_status_history').select(['from_status', 'to_status', 'actor_user_id']).where('post_id', '=', post).execute());
    expect(history).toEqual([{ from_status: 'erreur', to_status: 'en_publication', actor_user_id: admin }]);
    expect(await auditActions(org.orgId)).toEqual([expect.objectContaining({ action: 'support.publication_relancee', actor_kind: 'support' })]);
    await expect(retryPublicationAsSupport(db, admin, post, NOW)).rejects.toMatchObject({ code: 'publication_plus_en_erreur' });
  });

  it('ne relance jamais une issue incertaine (risque de doublon)', async () => {
    for (const outcome of ['unknown', null] as const) {
      const { post } = await failedPost(outcome);
      await expect(retryPublicationAsSupport(db, admin, post, NOW)).rejects.toMatchObject({ code: 'publication_incertaine' });
      expect((await asSystem(db, (trx) => trx.selectFrom('posts').select('status').where('id', '=', post).executeTakeFirstOrThrow())).status).toBe('erreur');
    }
  });

  it('refuse un post périmé, après son événement, ou sans connexion', async () => {
    const old = await failedPost('not_created', { scheduled_at: hours(-49) });
    await expect(retryPublicationAsSupport(db, admin, old.post, NOW)).rejects.toMatchObject({ code: 'publication_trop_ancienne' });
    const event = await failedPost('not_created', { must_publish_by: hours(-1) });
    await expect(retryPublicationAsSupport(db, admin, event.post, NOW)).rejects.toMatchObject({ code: 'evenement_passe' });
    const expired = await failedPost('not_created', {}, 'expired');
    await expect(retryPublicationAsSupport(db, admin, expired.post, NOW)).rejects.toMatchObject({ code: 'compte_non_connecte' });
    const marker = await failedPost('not_created', { body: 'Texte [À COMPLÉTER] encore.' });
    await expect(retryPublicationAsSupport(db, admin, marker.post, NOW)).rejects.toMatchObject({ code: 'marqueur_present' });
    const suspended = await failedPost('not_created');
    await suspendOrganization(db, admin, suspended.org.orgId, 'Contrôle en cours', NOW);
    await expect(retryPublicationAsSupport(db, admin, suspended.post, NOW)).rejects.toMatchObject({ code: 'organisation_suspendue' });
  });
});

describe('relance d’une rédaction', () => {
  const run = (workspaceId: string, status: 'failed' | 'done' | 'running', at: Date) =>
    asSystem(db, (trx) =>
      trx
        .insertInto('generation_runs')
        .values({ workspace_id: workspaceId, kind: 'weekly', status, started_at: at, finished_at: status === 'running' ? null : at, lease_until: status === 'running' ? hours(1) : null, error: status === 'failed' ? 'Fournisseur indisponible' : null })
        .execute(),
    );

  it('redemande la rédaction une seule fois, et seulement après un échec', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    await expect(relaunchGeneration(db, admin, ws, NOW)).rejects.toMatchObject({ code: 'rien_a_relancer' });
    await run(ws, 'failed', hours(-3));
    expect((await listFailedGenerations(db, admin, NOW)).find((g) => g.workspaceId === ws)).toMatchObject({ blockedBy: null, error: 'Fournisseur indisponible' });
    await relaunchGeneration(db, admin, ws, NOW);
    expect((await asSystem(db, (trx) => trx.selectFrom('workspaces').select('generation_requested_at').where('id', '=', ws).executeTakeFirstOrThrow())).generation_requested_at).toEqual(NOW);
    await expect(relaunchGeneration(db, admin, ws, hours(1))).rejects.toMatchObject({ code: 'redaction_deja_demandee' });
    expect(await auditActions(org.orgId)).toEqual([expect.objectContaining({ action: 'support.redaction_relancee', actor_kind: 'support' })]);
    await run(ws, 'running', hours(1));
    await expect(relaunchGeneration(db, admin, ws, hours(2))).rejects.toMatchObject({ code: 'redaction_en_cours' });
  });

  it('refuse sans droit à rédiger', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    await asSystem(db, (trx) => trx.updateTable('organizations').set({ trial_ends_at: days(-1) }).where('id', '=', org.orgId).execute());
    await run(ws, 'failed', hours(-3));
    await expect(relaunchGeneration(db, admin, ws, NOW)).rejects.toMatchObject({ code: 'quota_redaction_atteint' });
  });
});

describe('suivi des demandes de démonstration', () => {
  const input = { fullName: 'Camille Test', company: 'Suivi Démo', email: 'camille@exemple.fr', phone: '', accounts: '4', message: '', website: '' };
  const ok: DemoNotifier = { notify: async () => undefined };
  const failing: DemoNotifier = { notify: async () => Promise.reject(new Error('CRM : HTTP 500')) };

  it('statut, note et personne qui suit la demande', async () => {
    const id = (await createDemoRequest(db, ok, input, NOW)) as string;
    await expect(updateDemoRequest(db, admin, id, { status: 'inconnu', note: '' }, NOW)).rejects.toMatchObject({ code: 'statut_demo_invalide' });
    await updateDemoRequest(db, admin, id, { status: 'contactee', note: '  Rappel jeudi  ' }, NOW);
    const row = (await listDemoRequests(db, admin)).find((r) => r.id === id);
    expect(row).toMatchObject({ status: 'contactee', note: 'Rappel jeudi', handledAt: NOW, handledBy: expect.stringContaining('editeur') });
  });

  it('renvoie une transmission en échec, pas une demande déjà transmise', async () => {
    const id = (await createDemoRequest(db, failing, input, NOW)) as string;
    await expect(retryDemoForward(db, admin, failing, id)).rejects.toMatchObject({ code: 'transmission_demo_echouee' });
    await retryDemoForward(db, admin, ok, id);
    const row = (await listDemoRequests(db, admin)).find((r) => r.id === id);
    expect(row?.forwardedAt).not.toBeNull();
    expect(row?.forwardError).toBeNull();
    await expect(retryDemoForward(db, admin, ok, id)).rejects.toMatchObject({ code: 'demande_deja_transmise' });
  });
});

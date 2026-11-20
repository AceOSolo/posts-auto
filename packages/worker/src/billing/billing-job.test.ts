import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, openTestDatabase } from '@posts-auto/db/testing';
import { FakeBilling, applyBillingEvent, confirmSignup, requestSignup } from '@posts-auto/services';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryMediaStore } from '../media/media-store.ts';
import { runBillingTick } from './billing-job.ts';

let db: Database;
let owner: string;
let workspaceId: string;
let orgId: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const provider = new FakeBilling('http://localhost:3001');
const media = new MemoryMediaStore();

beforeAll(async () => {
  db = await openTestDatabase();
  const request = await requestSignup(db, { email: 'factu@exemple.fr', fullName: 'Factu', orgName: 'Factu SARL', orgKind: 'entreprise' }, NOW);
  if (request.kind !== 'confirm') throw new Error(request.kind);
  const outcome = await confirmSignup(db, request.token, NOW);
  if (!outcome.ok) throw new Error('inscription');
  owner = outcome.session.userId;
  workspaceId = outcome.workspaceId;
  orgId = (await asSystem(db, (trx) => trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow())).org_id;
  await createAccount(db, workspaceId);
  await createAccount(db, workspaceId);
  await asSystem(db, (trx) => trx.updateTable('plans').set({ stripe_price_monthly: 'price_job' }).where('key', '=', 'essentiel').execute());
  await applyBillingEvent(
    db,
    {
      kind: 'subscription',
      eventId: 'evt_job_1',
      orgId,
      customerId: 'cus_job',
      subscriptionId: 'sub_job',
      priceId: 'price_job',
      quantity: 1,
      status: 'active',
      interval: 'month',
      periodStart: NOW,
      periodEnd: days(30),
      cancelAtPeriodEnd: false,
    },
    NOW,
  );
});
afterAll(() => closeTestDatabase(db));

const notificationsOf = (kind: string) =>
  asSystem(db, (trx) => trx.selectFrom('notifications').select(['user_id', 'channel', 'payload']).where('kind', '=', kind).where('workspace_id', '=', workspaceId).execute());

describe('tâche de facturation', () => {
  it('quantité, alertes de quota et relances d’impayé', async () => {
    await asSystem(db, (trx) =>
      trx
        .insertInto('ai_usage')
        .values(Array.from({ length: 26 }, () => ({ workspace_id: workspaceId, provider: 'p', model: 'm', purpose: 'write' as const, kind: 'text' as const, counted_in_quota: true, at: NOW })))
        .execute(),
    );
    const first = await runBillingTick({ db, provider, media, clock: () => NOW });
    expect(first).toEqual({ quantities: 1, dunning: 0, usageAlerts: 1, purged: [] });
    expect(provider.quantities.get('sub_job')).toBe(2);
    const alerts = await notificationsOf('quota_alerte');
    expect(alerts.map((n) => n.channel).sort()).toEqual(['email', 'in_app']);
    expect(alerts[0]?.user_id).toBe(owner);

    await applyBillingEvent(db, { kind: 'payment_failed', eventId: 'evt_job_2', subscriptionId: 'sub_job' }, NOW);
    expect(await runBillingTick({ db, provider, media, clock: () => days(3) })).toMatchObject({ dunning: 1, usageAlerts: 0 });
    expect((await notificationsOf('impaye')).map((n) => (n.payload as { step: string }).step)).toEqual(['j3', 'j3']);
    // Sans fournisseur configuré, le reste tourne quand même.
    expect(await runBillingTick({ db, provider: null, media, clock: () => days(4) })).toEqual({ quantities: 0, dunning: 0, usageAlerts: 0, purged: [] });
  });
});

import { type Database, asSystem, asUser } from '@posts-auto/db';
import { closeTestDatabase, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBillingEvent } from '../billing/subscriptions.ts';
import { ForbiddenError } from '../errors.ts';
import { confirmSignup, requestSignup } from '../onboarding/signup.ts';
import { inviteMember } from './members.ts';
import { createWorkspace, listOrgWorkspaces, ownedOrganizations } from './workspaces.ts';

let db: Database;
const NOW = new Date('2026-11-20T10:00:00Z');

async function signup(email: string, orgKind: 'entreprise' | 'agence') {
  const request = await requestSignup(db, { email, fullName: email, orgName: `Org ${email}`, orgKind }, NOW);
  if (request.kind !== 'confirm') throw new Error(request.kind);
  const outcome = await confirmSignup(db, request.token, NOW);
  if (!outcome.ok) throw new Error('inscription');
  const orgId = (await asSystem(db, (trx) => trx.selectFrom('workspaces').select('org_id').where('id', '=', outcome.workspaceId).executeTakeFirstOrThrow())).org_id;
  return { userId: outcome.session.userId, workspaceId: outcome.workspaceId, orgId };
}

beforeAll(async () => {
  db = await openTestDatabase();
});
afterAll(() => closeTestDatabase(db));

describe('espaces de l’organisation (agences)', () => {
  it('une agence crée un espace par client, cloisonné ; le nom est unique', async () => {
    const agency = await signup('agence-ws@exemple.fr', 'agence');
    const client = await createWorkspace(db, agency.userId, agency.workspaceId, '  Boulangerie   Martin ', NOW);
    await expect(createWorkspace(db, agency.userId, agency.workspaceId, 'boulangerie martin', NOW)).rejects.toMatchObject({ code: 'espace_existe' });
    await expect(createWorkspace(db, agency.userId, agency.workspaceId, ' ', NOW)).rejects.toMatchObject({ code: 'nom_espace_invalide' });
    const list = await listOrgWorkspaces(db, agency.userId, agency.workspaceId);
    expect(list).toMatchObject({ orgKind: 'agence', maxWorkspaces: null, canCreate: true });
    expect(list.workspaces.map((w) => w.name)).toEqual(['Boulangerie Martin', 'Premier client']);
    expect(await ownedOrganizations(db, agency.userId)).toEqual([{ orgId: agency.orgId, kind: 'agence', workspaceId: agency.workspaceId }]);

    // Une personne invitée dans un espace client ne voit pas les autres.
    await inviteMember(db, agency.userId, client, { email: 'client-martin@exemple.fr', role: 'admin' }, NOW);
    const guest = await asSystem(db, (trx) => trx.selectFrom('users').select('id').where('email', '=', 'client-martin@exemple.fr').executeTakeFirstOrThrow());
    const visible = await asUser(db, guest.id, (trx) => trx.selectFrom('workspaces').select('id').execute());
    expect(visible.map((w) => w.id)).toEqual([client]);
    await expect(listOrgWorkspaces(db, guest.id, client)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createWorkspace(db, guest.id, client, 'Autre', NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('nombre d’espaces : une entreprise en a un, sauf formule qui en permet plus', async () => {
    const company = await signup('entreprise-ws@exemple.fr', 'entreprise');
    await expect(createWorkspace(db, company.userId, company.workspaceId, 'Filiale', NOW)).rejects.toMatchObject({ code: 'limite_espaces' });
    expect(await listOrgWorkspaces(db, company.userId, company.workspaceId)).toMatchObject({ maxWorkspaces: 1, canCreate: false });

    await asSystem(db, (trx) => trx.updateTable('plans').set({ stripe_price_monthly: 'price_agence_ws' }).where('key', '=', 'agence').execute());
    await applyBillingEvent(
      db,
      {
        kind: 'subscription',
        eventId: 'evt_ws_1',
        orgId: company.orgId,
        customerId: 'cus_ws',
        subscriptionId: 'sub_ws',
        priceId: 'price_agence_ws',
        quantity: 1,
        status: 'active',
        interval: 'month',
        periodStart: NOW,
        periodEnd: new Date('2026-12-20T10:00:00Z'),
        cancelAtPeriodEnd: false,
      },
      NOW,
    );
    await createWorkspace(db, company.userId, company.workspaceId, 'Filiale', NOW);
    expect((await listOrgWorkspaces(db, company.userId, company.workspaceId)).workspaces).toHaveLength(2);
  });
});

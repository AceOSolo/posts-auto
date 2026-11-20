import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createAccount, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSession } from '../auth/auth.ts';
import { applyBillingEvent } from '../billing/subscriptions.ts';
import { ForbiddenError } from '../errors.ts';
import { confirmSignup, requestSignup } from '../onboarding/signup.ts';
import { ensureGalleryTemplates } from '../visuals/branding.ts';
import { createWorkspace } from '../workspaces/workspaces.ts';
import { activeAnnouncements, createAnnouncement, endAnnouncement } from './announcements.ts';
import { galleryCatalog, listGalleryEntries, saveGalleryEntry, setGalleryEntryActive } from './gallery.ts';
import { listOrganizations, organizationDetail } from './organizations.ts';
import { loadPlatformSettings, requirePlatformAdmin, updatePlatformSettings } from './platform.ts';
import { aiModelsInUse, supervision } from './supervision.ts';
import { endSupportSession, grantSupportAccess, listSupportGrants, openSupportSession, revokeSupportAccess } from './support.ts';

let db: Database;
let admin: string;
let owner: string;
let workspaceId: string;
let orgId: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

beforeAll(async () => {
  db = await openTestDatabase();
  admin = await createUser(db, 'editeur');
  await asSystem(db, async (trx) => {
    await trx.insertInto('platform_admins').values({ user_id: admin }).execute();
  });
  const request = await requestSignup(db, { email: 'client-adm@exemple.fr', fullName: 'Client', orgName: 'Client ADM', orgKind: 'agence' }, NOW);
  if (request.kind !== 'confirm') throw new Error(request.kind);
  const outcome = await confirmSignup(db, request.token, NOW);
  if (!outcome.ok) throw new Error('inscription');
  owner = outcome.session.userId;
  workspaceId = outcome.workspaceId;
  orgId = (await asSystem(db, (trx) => trx.selectFrom('workspaces').select('org_id').where('id', '=', workspaceId).executeTakeFirstOrThrow())).org_id;
  await createAccount(db, workspaceId);
  await asSystem(db, (trx) =>
    trx.insertInto('ai_usage').values({ workspace_id: workspaceId, provider: 'anthropic', model: 'claude-opus-5-5', purpose: 'write', kind: 'text', counted_in_quota: true, cost_eur: '0.12', at: NOW }).execute(),
  );
});
afterAll(() => closeTestDatabase(db));

describe('accès au back-office', () => {
  it('réservé à l’éditeur, avec la double authentification active', async () => {
    await expect(requirePlatformAdmin(db, owner)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requirePlatformAdmin(db, admin)).rejects.toMatchObject({ code: 'mfa_requise_admin' });
    await asSystem(db, (trx) => trx.insertInto('user_totp').values({ user_id: admin, secret_encrypted: Buffer.from('x'), confirmed_at: NOW }).execute());
    await expect(requirePlatformAdmin(db, admin)).resolves.toBeUndefined();
    await expect(listOrganizations(db, owner, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('ADM-01 : organisations', () => {
  it('formule, comptes, usage, revenu mensuel, état de paiement, activité', async () => {
    await asSystem(db, (trx) => trx.updateTable('plans').set({ stripe_price_monthly: 'price_adm', price_monthly_cents: 3900 }).where('key', '=', 'agence').execute());
    await applyBillingEvent(
      db,
      {
        kind: 'subscription',
        eventId: 'evt_adm',
        orgId,
        customerId: 'cus_adm',
        subscriptionId: 'sub_adm',
        priceId: 'price_adm',
        quantity: 2,
        status: 'active',
        interval: 'month',
        periodStart: NOW,
        periodEnd: hours(24 * 30),
        cancelAtPeriodEnd: false,
      },
      NOW,
    );
    const rows = await listOrganizations(db, admin, NOW, 'adm');
    expect(rows).toEqual([
      expect.objectContaining({ name: 'Client ADM', kind: 'agence', planName: 'Agence', paymentState: 'a_jour', activeAccounts: 1, postsThisMonth: 1, aiCostEurThisMonth: 0.12, mrrCents: 7800 }),
    ]);
    expect(rows[0]?.lastActivityAt).not.toBeNull();
    const detail = await organizationDetail(db, admin, orgId, NOW);
    expect(detail.people).toEqual([expect.objectContaining({ email: 'client-adm@exemple.fr', roles: expect.stringContaining('propriétaire'), mfa: false })]);
    expect(detail.subscription).toMatchObject({ planName: 'Agence', quantity: 2 });
  });
});

describe('ADM-03 et ADM-04 : supervision, paramètres', () => {
  it('files, erreurs, connexions, coûts par fournisseur', async () => {
    const s = await supervision(db, admin, NOW);
    expect(s.aiCosts).toEqual([expect.objectContaining({ provider: 'anthropic', kind: 'text', calls: 1, costEurThisMonth: 0.12 })]);
    expect(s.accounts).toMatchObject({ expired: 0 });
    expect((await aiModelsInUse(db, admin, NOW)).models).toEqual([expect.objectContaining({ model: 'claude-opus-5-5', purpose: 'write', calls: 1 })]);
  });

  it('valeurs par défaut appliquées aux nouveaux espaces', async () => {
    await expect(updatePlatformSettings(db, admin, { image_budget_monthly: '5000' }, NOW)).rejects.toMatchObject({ code: 'parametre_invalide' });
    const settings = await updatePlatformSettings(db, admin, { image_budget_monthly: '12', min_gap_minutes: '45', posts_per_week: '' }, NOW);
    expect(settings).toMatchObject({ image_budget_monthly: 12, min_gap_minutes: 45, posts_per_week: 1 });
    const created = await createWorkspace(db, owner, workspaceId, 'Client numéro 2', NOW);
    const row = await asSystem(db, (trx) => trx.selectFrom('workspaces').select(['image_budget_monthly', 'min_gap_minutes']).where('id', '=', created).executeTakeFirstOrThrow());
    expect(row).toEqual({ image_budget_monthly: 12, min_gap_minutes: 45 });
    expect((await asSystem(db, (trx) => loadPlatformSettings(trx))).image_budget_monthly).toBe(12);
  });
});

describe('ADM-05 : galerie de départ', () => {
  it('modèle intégré retiré, modèle de l’éditeur ajouté aux couleurs de l’espace', async () => {
    await expect(saveGalleryEntry(db, admin, { key: 'titre-points', name: 'X', definitionJson: '{}', withPhoto: false }, NOW)).rejects.toMatchObject({ code: 'cle_reservee' });
    await expect(saveGalleryEntry(db, admin, { key: 'annonce-editeur', name: 'Annonce', definitionJson: '{"format":"carre"}', withPhoto: false }, NOW)).rejects.toMatchObject({ code: 'definition_invalide' });
    const definition = {
      format: 'square',
      background: 'brand.primary',
      zones: [{ key: 'titre', kind: 'title', box: { x: 80, y: 80, w: 920, h: 600 }, style: { color: 'brand.light', font: 'brand.font', weight: 800, maxSize: 80, minSize: 40, align: 'center', lineHeight: 1.2 } }],
    };
    await saveGalleryEntry(db, admin, { key: 'annonce-editeur', name: 'Annonce', definitionJson: JSON.stringify(definition), withPhoto: false }, NOW);
    await setGalleryEntryActive(db, admin, 'titre-points', false, NOW);
    const entries = await listGalleryEntries(db, admin);
    expect(entries.find((e) => e.key === 'titre-points')).toMatchObject({ builtin: true, active: false });
    expect(entries.find((e) => e.key === 'annonce-editeur')).toMatchObject({ builtin: false, active: true });

    const brand = { primary: '#112233', secondary: '#445566', light: '#fafafa', dark: '#000000', font: 'lora' as const };
    const catalog = await asSystem(db, (trx) => galleryCatalog(trx, brand));
    expect(catalog.map((t) => t.key)).not.toContain('titre-points');
    const custom = catalog.find((t) => t.key === 'annonce-editeur');
    expect(custom?.definition.background).toBe('#112233');
    expect(custom?.definition.zones[0]?.style).toMatchObject({ color: '#fafafa', font: 'lora' });

    const fresh = await createWorkspace(db, owner, workspaceId, 'Client numéro 3', NOW);
    await asSystem(db, (trx) => ensureGalleryTemplates(trx, fresh));
    const keys = (await asSystem(db, (trx) => trx.selectFrom('templates').select('gallery_key').where('workspace_id', '=', fresh).execute())).map((t) => t.gallery_key);
    expect(keys).toContain('annonce-editeur');
    expect(keys).not.toContain('titre-points');
  });
});

describe('ADM-06 : annonces', () => {
  it('affichée pendant sa période, retirée à la demande', async () => {
    const id = await createAnnouncement(db, admin, { message: 'Maintenance dimanche de 8 h à 9 h', level: 'maintenance', startsAt: NOW, endsAt: hours(48) }, NOW);
    expect(await activeAnnouncements(db, hours(1))).toEqual([expect.objectContaining({ id, level: 'maintenance' })]);
    expect(await activeAnnouncements(db, hours(49))).toEqual([]);
    await endAnnouncement(db, admin, id, hours(2));
    expect(await activeAnnouncements(db, hours(3))).toEqual([]);
  });
});

describe('ADM-02 : intervention du support avec l’accord du client', () => {
  it('accord, session « en tant que », trace, fin à l’expiration ou au retrait', async () => {
    const contributor = await createUser(db, 'contrib-adm');
    await asSystem(db, (trx) => trx.insertInto('workspace_members').values({ workspace_id: workspaceId, user_id: contributor, role: 'contributor' }).execute());
    await expect(grantSupportAccess(db, contributor, workspaceId, { hours: 4, reason: '' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(grantSupportAccess(db, owner, workspaceId, { hours: 100, reason: '' }, NOW)).rejects.toMatchObject({ code: 'duree_invalide' });
    const grantId = await grantSupportAccess(db, owner, workspaceId, { hours: 4, reason: 'Problème de planning' }, NOW);
    expect(await listSupportGrants(db, owner, workspaceId, NOW)).toEqual([expect.objectContaining({ id: grantId, grantedBy: 'client-adm@exemple.fr' })]);

    await expect(openSupportSession(db, owner, grantId, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    const support = await openSupportSession(db, admin, grantId, hours(1));
    const session = await resolveSession(db, support.sessionToken, hours(2));
    expect(session).toMatchObject({ userId: owner, supportAdminId: admin, mfaPending: false, expiresAt: hours(4) });
    expect(await resolveSession(db, support.sessionToken, hours(5))).toBeNull();

    const again = await openSupportSession(db, admin, grantId, hours(2));
    await endSupportSession(db, again.sessionToken, hours(2.5));
    expect(await resolveSession(db, again.sessionToken, hours(2.6))).toBeNull();

    const third = await openSupportSession(db, admin, grantId, hours(3));
    await revokeSupportAccess(db, owner, workspaceId, grantId, hours(3.1));
    expect(await resolveSession(db, third.sessionToken, hours(3.2))).toBeNull();
    await expect(openSupportSession(db, admin, grantId, hours(3.3))).rejects.toMatchObject({ code: 'acces_support_expire' });

    const trail = await asSystem(db, (trx) => trx.selectFrom('audit_log').select(['action', 'actor_kind']).where('workspace_id', '=', workspaceId).where('action', 'like', 'support.%').orderBy('id').execute());
    expect(trail).toEqual([
      { action: 'support.acces_accorde', actor_kind: 'user' },
      { action: 'support.session_ouverte', actor_kind: 'support' },
      { action: 'support.session_ouverte', actor_kind: 'support' },
      { action: 'support.session_terminee', actor_kind: 'support' },
      { action: 'support.session_ouverte', actor_kind: 'support' },
      { action: 'support.acces_retire', actor_kind: 'user' },
    ]);
  });
});

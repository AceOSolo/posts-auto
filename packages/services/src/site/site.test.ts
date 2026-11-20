import { type Database, asSystem } from '@posts-auto/db';
import { closeTestDatabase, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_REQUESTS_PER_IP_PER_HOUR, type DemoNotifier, createDemoRequest, publicPlans, saveSiteTestimonial, simulatePrice, siteTestimonial } from './site.ts';

let db: Database;
let admin: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const sent: string[] = [];
const notifier: DemoNotifier = { notify: async (r) => void sent.push(r.company) };
const input = { fullName: 'Prospect', company: 'Prospect SAS', email: 'prospect@exemple.fr', phone: '', accounts: '4', message: '', website: '' };

beforeAll(async () => {
  db = await openTestDatabase();
  admin = await createUser(db, 'editeur-site');
  await asSystem(db, async (trx) => {
    await trx.insertInto('platform_admins').values({ user_id: admin }).execute();
    await trx.insertInto('user_totp').values({ user_id: admin, secret_encrypted: Buffer.from('x'), confirmed_at: NOW }).execute();
    await trx.updateTable('plans').set({ price_monthly_cents: 2900, price_yearly_cents: 29000 }).where('key', '=', 'essentiel').execute();
  });
});
afterAll(() => closeTestDatabase(db));

describe('site vitrine', () => {
  it('SIT-03 : prix et posts inclus selon le nombre de comptes', async () => {
    const [essentiel] = simulatePrice(await publicPlans(db), 3, 2);
    expect(essentiel).toMatchObject({ accounts: 5, monthlyCents: 14500, yearlyMonthlyCents: 12083, postsPerMonth: 80 });
    expect(simulatePrice(await publicPlans(db), 0, 0)[0]?.accounts).toBe(1);
  });

  it('SIT-02 : demande enregistrée et transmise ; robots ignorés ; 5 par heure et par IP', async () => {
    expect(await createDemoRequest(db, notifier, { ...input, website: 'http://spam' }, NOW, '203.0.113.9')).toBeNull();
    await expect(createDemoRequest(db, notifier, { ...input, email: 'pas-une-adresse' }, NOW)).rejects.toMatchObject({ code: 'email_invalide' });
    for (let i = 0; i < DEMO_REQUESTS_PER_IP_PER_HOUR; i += 1) expect(await createDemoRequest(db, notifier, input, NOW, '203.0.113.9')).toBeTypeOf('string');
    await expect(createDemoRequest(db, notifier, input, NOW, '203.0.113.9')).rejects.toMatchObject({ code: 'trop' });
    expect(sent).toHaveLength(DEMO_REQUESTS_PER_IP_PER_HOUR);
    const failing: DemoNotifier = { notify: async () => Promise.reject(new Error('CRM : HTTP 500')) };
    const id = await createDemoRequest(db, failing, input, NOW, '198.51.100.1');
    const row = await asSystem(db, (trx) => trx.selectFrom('demo_requests').select(['forwarded_at', 'forward_error']).where('id', '=', id as string).executeTakeFirstOrThrow());
    expect(row).toEqual({ forwarded_at: null, forward_error: 'CRM : HTTP 500' });
  });

  it('SIT-08 : témoignage seulement avec la date de l’accord écrit', async () => {
    expect(await siteTestimonial(db)).toBeNull();
    await expect(saveSiteTestimonial(db, admin, { quote: 'Très utile', author: 'X', role: '', company: '', consentOn: '' }, NOW)).rejects.toMatchObject({ code: 'temoignage_incomplet' });
    await saveSiteTestimonial(db, admin, { quote: 'Très utile', author: 'Alexis', role: 'Communication', company: 'Secutop', consentOn: '2026-11-20' }, NOW);
    expect(await siteTestimonial(db)).toMatchObject({ quote: 'Très utile', company: 'Secutop' });
    await saveSiteTestimonial(db, admin, { quote: '', author: '', role: '', company: '', consentOn: '' }, NOW);
    expect(await siteTestimonial(db)).toBeNull();
  });
});

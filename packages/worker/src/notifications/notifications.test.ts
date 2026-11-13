import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { ConsoleMailer, type MailMessage, MailError, type Mailer } from '@posts-auto/services';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from './recipients.ts';
import { runEmailDispatch } from './email-dispatch.ts';
import { runValidationReminders } from './reminders.ts';

let db: Database;
let workspaceId: string;
let holderId: string;
let delegateId: string;
let accountId: string;
// Lundi 16 novembre 2026, 9h00 à Paris.
const MONDAY_9H = new Date('2026-11-16T08:00:00Z');
const hours = (n: number) => new Date(MONDAY_9H.getTime() + n * 3_600_000);

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  holderId = await createUser(db, 'titulaire');
  delegateId = await createUser(db, 'deleguee');
  await addMember(db, workspaceId, holderId, 'contributor');
  await addMember(db, workspaceId, delegateId, 'editor');
  accountId = await createAccount(db, workspaceId, { holder_user_id: holderId, display_name: 'JP' });
  await asSystem(db, (trx) => trx.insertInto('account_delegates').values({ account_id: accountId, workspace_id: workspaceId, user_id: delegateId }).execute());
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterAll(() => closeTestDatabase(db));
beforeEach(async () => {
  await asSystem(db, (trx) => trx.deleteFrom('notifications').execute());
});

const notifications = (kind?: string) =>
  asSystem(db, (trx) => {
    let q = trx.selectFrom('notifications').select(['id', 'user_id', 'kind', 'channel', 'payload', 'delivery_status', 'delivery_attempts']);
    if (kind) q = q.where('kind', '=', kind);
    return q.orderBy('id').execute();
  });

describe('rappels de validation (VAL-05)', () => {
  it('24 h puis 3 h avant le créneau, au titulaire et à la déléguée, une fois chacun', async () => {
    const postId = await createPost(db, workspaceId, accountId, { scheduled_at: hours(30) });
    expect((await runValidationReminders({ db, clock: () => hours(5) })).reminders).toEqual([]); // à 25 h
    expect((await runValidationReminders({ db, clock: () => hours(7) })).reminders).toEqual([`${postId}:24h`]);
    expect((await runValidationReminders({ db, clock: () => hours(8) })).reminders).toEqual([]);
    expect((await runValidationReminders({ db, clock: () => hours(27.5) })).reminders).toEqual([`${postId}:3h`]);
    const sent = await notifications('rappel_validation');
    expect(new Set(sent.map((n) => n.user_id))).toEqual(new Set([holderId, delegateId]));
    expect(sent.filter((n) => n.channel === 'email')).toHaveLength(4);
  });

  it('un post déposé 2 heures avant son créneau ne reçoit que le rappel le plus urgent', async () => {
    const postId = await createPost(db, workspaceId, accountId, { scheduled_at: hours(40) });
    expect((await runValidationReminders({ db, clock: () => hours(38) })).reminders).toEqual([`${postId}:3h`]);
    expect((await runValidationReminders({ db, clock: () => hours(39) })).reminders).toEqual([]);
  });

  it('un post replanifié reçoit de nouveaux rappels pour son nouveau créneau', async () => {
    const postId = await createPost(db, workspaceId, accountId, { scheduled_at: hours(50) });
    await runValidationReminders({ db, clock: () => hours(48) });
    await asSystem(db, (trx) => trx.updateTable('posts').set({ scheduled_at: hours(74) }).where('id', '=', postId).execute());
    expect((await runValidationReminders({ db, clock: () => hours(51) })).reminders).toEqual([`${postId}:24h`]);
  });

  it('aucun rappel pour un post déjà validé', async () => {
    await createPost(db, workspaceId, accountId, { scheduled_at: hours(60), status: 'valide' });
    expect((await runValidationReminders({ db, clock: () => hours(59) })).reminders).toEqual([]);
  });
});

describe('récapitulatif du lundi matin', () => {
  it('à partir de 8 h, une notification par personne et par semaine', async () => {
    await createPost(db, workspaceId, accountId, { scheduled_at: new Date('2026-11-19T11:00:00Z') });
    const early = await runValidationReminders({ db, clock: () => new Date('2026-11-16T06:30:00Z') }); // 7h30
    expect(early.recaps).toEqual([]);
    const report = await runValidationReminders({ db, clock: () => MONDAY_9H });
    expect(report.recaps.sort()).toEqual([`${delegateId}:2026-11-16`, `${holderId}:2026-11-16`].sort());
    const recap = (await notifications('recap_hebdo')).find((n) => n.user_id === holderId);
    expect(recap?.payload).toMatchObject({ week: '2026-11-16' });
    expect((await runValidationReminders({ db, clock: () => hours(1) })).recaps).toEqual([]);
  });
});

describe('envoi des e-mails', () => {
  it('envoie les notifications e-mail et seulement celles-là', async () => {
    await asSystem(db, (trx) => notify(trx, [holderId], workspaceId, 'connexion_expiree', { accountName: 'JP' }, ['email', 'in_app']));
    const mailer = new ConsoleMailer();
    const report = await runEmailDispatch({ db, mailer, appUrl: 'https://app.example', clock: () => MONDAY_9H });
    expect(report.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ subject: 'La connexion LinkedIn de JP a expiré', tag: 'connexion_expiree' });
    const rows = await notifications('connexion_expiree');
    expect(rows.find((r) => r.channel === 'email')?.delivery_status).toBe('sent');
    expect(rows.find((r) => r.channel === 'in_app')?.delivery_status).toBeNull();
  });

  it('le rappel contient un lien « Valider maintenant » créé à l’envoi, seulement si le post attend une décision (VAL-06)', async () => {
    const pending = await createPost(db, workspaceId, accountId, { scheduled_at: hours(90) });
    const validated = await createPost(db, workspaceId, accountId, { scheduled_at: hours(95), status: 'valide' });
    await asSystem(db, async (trx) => {
      await notify(trx, [holderId], workspaceId, 'rappel_validation', { postId: pending, hours: 24, scheduledAt: hours(90).toISOString() }, ['email']);
      await notify(trx, [holderId], workspaceId, 'rappel_validation', { postId: validated, hours: 24, scheduledAt: hours(95).toISOString() }, ['email']);
    });
    const mailer = new ConsoleMailer();
    await runEmailDispatch({ db, mailer, appUrl: 'https://app.example', clock: () => MONDAY_9H });
    const [first, second] = mailer.sent;
    expect(first?.text).toMatch(/Valider maintenant : https:\/\/app\.example\/valider\/[A-Za-z0-9_-]{43}/);
    expect(second?.text).not.toContain('/valider/');
    const links = await asSystem(db, (trx) => trx.selectFrom('approval_links').select(['post_id', 'user_id']).execute());
    expect(links).toEqual([{ post_id: pending, user_id: holderId }]);
  });

  it('respecte la préférence « pas d’e-mail » pour ce type (NOT-01)', async () => {
    await asSystem(db, async (trx) => {
      await trx.insertInto('notification_prefs').values({ user_id: delegateId, kind: 'rappel_validation', email: false }).execute();
      await notify(trx, [delegateId], workspaceId, 'rappel_validation', { postId: 'p', hours: 3 }, ['email']);
    });
    const mailer = new ConsoleMailer();
    const report = await runEmailDispatch({ db, mailer, appUrl: 'https://app.example', clock: () => MONDAY_9H });
    expect(report.skipped).toHaveLength(1);
    expect(mailer.sent).toHaveLength(0);
  });

  it('réessaie un échec passager au passage suivant, puis abandonne au 5e essai', async () => {
    await asSystem(db, (trx) => notify(trx, [holderId], workspaceId, 'connexion_expiree', { accountName: 'JP' }, ['email']));
    const failing: Mailer = { send: vi.fn(async (_: MailMessage) => Promise.reject(new MailError('Brevo injoignable', true))) };
    for (let pass = 1; pass <= 4; pass += 1) {
      const report = await runEmailDispatch({ db, mailer: failing, appUrl: 'https://app.example', clock: () => MONDAY_9H });
      expect(report.retrying).toHaveLength(1); // une seule tentative par passage
    }
    expect((await runEmailDispatch({ db, mailer: failing, appUrl: 'https://app.example', clock: () => MONDAY_9H })).failed).toHaveLength(1);
    expect((await notifications('connexion_expiree'))[0]).toMatchObject({ delivery_status: 'failed', delivery_attempts: 5 });
  });

  it('un échec définitif (adresse refusée) n’est pas réessayé', async () => {
    await asSystem(db, (trx) => notify(trx, [holderId], workspaceId, 'connexion_expiree', { accountName: 'JP' }, ['email']));
    const refusing: Mailer = { send: async () => Promise.reject(new MailError('Adresse invalide', false)) };
    expect((await runEmailDispatch({ db, mailer: refusing, appUrl: 'https://app.example', clock: () => MONDAY_9H })).failed).toHaveLength(1);
  });

  it('n’envoie plus une notification de plus de 3 jours', async () => {
    await asSystem(db, (trx) => notify(trx, [holderId], workspaceId, 'rappel_validation', { postId: 'p', hours: 3 }, ['email']));
    const mailer = new ConsoleMailer();
    const report = await runEmailDispatch({ db, mailer, appUrl: 'https://app.example', clock: () => new Date(Date.now() + 4 * 86_400_000) });
    expect(report.stale).toBe(1);
    expect(mailer.sent).toHaveLength(0);
  });
});

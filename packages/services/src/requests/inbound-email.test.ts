import { randomUUID } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import { listIdeas, listPostRequests } from './ideas-requests.ts';
import {
  INBOUND_DAILY_LIMIT,
  type InboundEmail,
  disableInboundAddress,
  handleInboundWebhook,
  inboundConfigFromEnv,
  inboundEmailSettings,
  inboundToken,
  parseBrevoInbound,
  parseInboundSubject,
  processInboundEmail,
  renewInboundAddress,
} from './inbound-email.ts';

const config = { domain: 'reply.exemple.test', secret: 'secret-des-adresses', webhookSecret: 'secret-du-webhook' };
const media = { write: async () => undefined };
const NOW = new Date('2026-11-23T09:00:00Z');

let db: Database;
let workspaceId: string;
let address: string;
const people = { editor: '', contributor: '', viewer: '', stranger: '' };
const emails = { editor: '', contributor: '', viewer: '', stranger: '' };
let held: string;

const mail = (overrides: Partial<InboundEmail> = {}): InboundEmail => ({
  messageId: `<${randomUUID()}@exemple.test>`,
  from: emails.contributor,
  recipients: [address],
  subject: 'Idée : retour de chantier',
  text: 'Belle opération à Lyon. Voir https://exemple.test/article.',
  spamScore: 1,
  spfFailed: false,
  ...overrides,
});

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  for (const name of Object.keys(people) as (keyof typeof people)[]) {
    people[name] = await createUser(db, name);
    const id = people[name];
    emails[name] = (await asSystem(db, (trx) => trx.selectFrom('users').select('email').where('id', '=', id).executeTakeFirstOrThrow())).email;
  }
  await addMember(db, workspaceId, people.editor, 'editor');
  await addMember(db, workspaceId, people.contributor, 'contributor');
  await addMember(db, workspaceId, people.viewer, 'viewer');
  held = await createAccount(db, workspaceId, { display_name: 'Profil de l’éditeur', holder_user_id: people.editor });
  address = await renewInboundAddress(db, people.editor, workspaceId, config, NOW);
});
afterAll(() => closeTestDatabase(db));

describe('configuration et adresse', () => {
  it('exige les trois valeurs', () => {
    expect(inboundConfigFromEnv({ INBOUND_EMAIL_DOMAIN: 'Reply.Exemple.test', INBOUND_EMAIL_SECRET: 'a', INBOUND_EMAIL_WEBHOOK_SECRET: 'b' })).toEqual({ domain: 'reply.exemple.test', secret: 'a', webhookSecret: 'b' });
    expect(inboundConfigFromEnv({ INBOUND_EMAIL_DOMAIN: 'reply.exemple.test', INBOUND_EMAIL_SECRET: 'a' })).toBeNull();
  });

  it('dérive une adresse stable, propre à l’espace et à sa rotation', () => {
    const token = inboundToken('s', workspaceId, 1);
    expect(token).toMatch(/^[a-z2-7]{26}$/);
    expect(inboundToken('s', workspaceId, 1)).toBe(token);
    expect(inboundToken('s', workspaceId, 2)).not.toBe(token);
    expect(inboundToken('autre', workspaceId, 1)).not.toBe(token);
  });

  it('montre l’adresse aux membres qui peuvent proposer, pas aux lecteurs', async () => {
    expect(await inboundEmailSettings(db, people.contributor, workspaceId, config)).toEqual({ available: true, address, canManage: false });
    expect(await inboundEmailSettings(db, people.viewer, workspaceId, config)).toEqual({ available: false, address: null, canManage: false });
    expect((await inboundEmailSettings(db, people.editor, workspaceId, null)).available).toBe(false);
    await expect(inboundEmailSettings(db, people.stranger, workspaceId, config)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('réserve la gestion de l’adresse à la gestion du contenu', async () => {
    await expect(renewInboundAddress(db, people.contributor, workspaceId, config, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(disableInboundAddress(db, people.viewer, workspaceId, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(renewInboundAddress(db, people.editor, workspaceId, null, NOW)).rejects.toMatchObject({ code: 'email_non_configure' });
  });

  it('une adresse renouvelée remplace la précédente ; une adresse désactivée ne reçoit plus rien', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    const first = await renewInboundAddress(db, org.ownerId, ws, config, NOW);
    const second = await renewInboundAddress(db, org.ownerId, ws, config, NOW);
    expect(second).not.toBe(first);
    const owner = (await asSystem(db, (trx) => trx.selectFrom('users').select('email').where('id', '=', org.ownerId).executeTakeFirstOrThrow())).email;
    expect(await processInboundEmail(db, media, config, mail({ from: owner, recipients: [first] }), NOW)).toEqual({ kind: 'ignored', reason: 'adresse_inconnue' });
    expect((await processInboundEmail(db, media, config, mail({ from: owner, recipients: [second] }), NOW)).kind).toBe('idea');
    await disableInboundAddress(db, org.ownerId, ws, NOW);
    expect(await processInboundEmail(db, media, config, mail({ from: owner, recipients: [second] }), NOW)).toEqual({ kind: 'ignored', reason: 'adresse_inconnue' });
  });
});

describe('lecture du webhook Brevo', () => {
  it('accepte les deux formes de la documentation', () => {
    const [a, b] = parseBrevoInbound({
      items: [
        { MessageId: '<a>', From: { Address: 'a@x.test', Name: 'A' }, To: [{ Address: 'to@x.test' }], Recipients: ['rcpt@x.test'], Subject: 'S', ExtractedMarkdownMessage: 'Corps', RawTextBody: 'Brut', SpamScore: 3.3, Headers: { 'Received-SPF': 'pass (ok)' } },
        { MessageId: '<b>', From: { Address: 'b@x.test' }, To: [], Subject: 'T', RawTextBody: 'Brut', Spam: { Score: 7 }, Headers: { 'Received-SPF': ['fail (non)', 'pass'] } },
      ],
    });
    expect(a).toMatchObject({ from: 'a@x.test', recipients: ['rcpt@x.test', 'to@x.test'], text: 'Corps', spamScore: 3.3, spfFailed: false });
    expect(b).toMatchObject({ text: 'Brut', spamScore: 7, spfFailed: true });
  });

  it('ignore une charge sans e-mails', () => {
    expect(parseBrevoInbound(null)).toEqual([]);
    expect(parseBrevoInbound({ items: 'non' })).toEqual([]);
  });

  it('lit l’objet', () => {
    expect(parseInboundSubject('Demande : post salon')).toEqual({ kind: 'request', title: 'post salon' });
    expect(parseInboundSubject('Fwd: Re: Idée: nouveau chantier')).toEqual({ kind: 'idea', title: 'nouveau chantier' });
    expect(parseInboundSubject('TR : Une info')).toEqual({ kind: 'idea', title: 'Une info' });
  });
});

describe('traitement (IDE-07)', () => {
  it('crée une idée au nom du membre, avec le premier lien', async () => {
    const outcome = await processInboundEmail(db, media, config, mail(), NOW);
    expect(outcome.kind).toBe('idea');
    const { ideas } = await listIdeas(db, people.editor, workspaceId);
    const idea = ideas.find((i) => outcome.kind === 'idea' && i.id === outcome.id);
    expect(idea).toMatchObject({ title: 'retour de chantier', link: 'https://exemple.test/article', status: 'new', allAccounts: true, authorName: 'contributor' });
  });

  it('« Demande : » crée une demande sur les comptes dont l’expéditeur est titulaire', async () => {
    const outcome = await processInboundEmail(db, media, config, mail({ from: emails.editor, subject: 'Demande : post du salon' }), NOW);
    expect(outcome.kind).toBe('request');
    const { requests } = await listPostRequests(db, people.editor, workspaceId);
    expect(requests.find((r) => outcome.kind === 'request' && r.id === outcome.id)).toMatchObject({ title: 'post du salon', accountIds: [held] });
  });

  it('une demande sans compte tenu reste une idée', async () => {
    expect((await processInboundEmail(db, media, config, mail({ subject: 'Demande : sans compte' }), NOW)).kind).toBe('idea');
  });

  it('sans objet, le titre vient de la première ligne', async () => {
    const outcome = await processInboundEmail(db, media, config, mail({ subject: '', text: '\nPremière ligne\nSuite' }), NOW);
    const { ideas } = await listIdeas(db, people.editor, workspaceId);
    expect(ideas.find((i) => outcome.kind === 'idea' && i.id === outcome.id)?.title).toBe('Première ligne');
    expect(await processInboundEmail(db, media, config, mail({ subject: '', text: '' }), NOW)).toEqual({ kind: 'ignored', reason: 'vide' });
  });

  it('écarte les expéditeurs non autorisés', async () => {
    for (const from of [emails.stranger, emails.viewer, 'inconnu@exemple.test', 'pas une adresse', null]) {
      expect(await processInboundEmail(db, media, config, mail({ from }), NOW)).toEqual({ kind: 'ignored', reason: 'expediteur_refuse' });
    }
  });

  it('écarte une adresse inconnue, un autre domaine, un indésirable et un échec SPF', async () => {
    expect(await processInboundEmail(db, media, config, mail({ recipients: ['contact@reply.exemple.test'] }), NOW)).toEqual({ kind: 'ignored', reason: 'adresse_inconnue' });
    expect(await processInboundEmail(db, media, config, mail({ recipients: [address.replace('reply.exemple.test', 'autre.test')] }), NOW)).toEqual({ kind: 'ignored', reason: 'adresse_inconnue' });
    expect(await processInboundEmail(db, media, config, mail({ spamScore: 5 }), NOW)).toEqual({ kind: 'ignored', reason: 'indesirable' });
    expect(await processInboundEmail(db, media, config, mail({ spfFailed: true }), NOW)).toEqual({ kind: 'ignored', reason: 'spf' });
  });

  it('accepte l’adresse quelle que soit la casse', async () => {
    expect((await processInboundEmail(db, media, config, mail({ recipients: [address.toUpperCase()] }), NOW)).kind).toBe('idea');
  });

  it('ne traite pas deux fois le même message, même reçu en même temps', async () => {
    const email = mail();
    const results = await Promise.all([processInboundEmail(db, media, config, email, NOW), processInboundEmail(db, media, config, email, NOW)]);
    expect(results.filter((r) => r.kind === 'idea')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'ignored' && r.reason === 'doublon')).toHaveLength(1);
  });

  it('rend le message à nouveau traitable après une erreur passagère', async () => {
    const email = mail({ subject: 'Idée : erreur passagère' });
    // Transactions : adresse, réservation, puis recherche de l'expéditeur, qui échoue ici.
    let transactions = 0;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction') {
          transactions += 1;
          if (transactions === 3) throw new Error('base indisponible');
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(processInboundEmail(flaky, media, config, email, NOW)).rejects.toThrow('base indisponible');
    expect((await processInboundEmail(db, media, config, email, NOW)).kind).toBe('idea');
  });

  it('retire les caractères nuls, que la base refuse', async () => {
    const [parsed] = parseBrevoInbound({ items: [{ MessageId: '<n\u0000ul>', From: { Address: `${emails.contributor}\u0000` }, To: [{ Address: address }], Subject: 'Idée : a\u0000b', RawTextBody: 'c\u0000d' }] });
    expect(parsed).toMatchObject({ messageId: '<nul>', from: emails.contributor, subject: 'Idée : ab', text: 'cd' });
    expect((await processInboundEmail(db, media, config, parsed as InboundEmail, NOW)).kind).toBe('idea');
  });

  it('applique la limite quotidienne, puis l’oublie après 24 h', async () => {
    const org = await createOrganization(db);
    const ws = org.workspaceIds[0] as string;
    const to = await renewInboundAddress(db, org.ownerId, ws, config, NOW);
    const owner = (await asSystem(db, (trx) => trx.selectFrom('users').select('email').where('id', '=', org.ownerId).executeTakeFirstOrThrow())).email;
    await asSystem(db, (trx) =>
      trx
        .insertInto('inbound_emails')
        .values(Array.from({ length: INBOUND_DAILY_LIMIT }, (_, i) => ({ workspace_id: ws, message_hash: `limite-${i}`, outcome: 'idea', received_at: NOW })))
        .execute(),
    );
    expect(await processInboundEmail(db, media, config, mail({ from: owner, recipients: [to] }), NOW)).toEqual({ kind: 'ignored', reason: 'limite' });
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    expect((await processInboundEmail(db, media, config, mail({ from: owner, recipients: [to] }), later)).kind).toBe('idea');
  });
});

describe('webhook', () => {
  const body = () => JSON.stringify({ items: [{ MessageId: `<${randomUUID()}>`, From: { Address: emails.contributor }, To: [{ Address: address }], Subject: 'Idée : par webhook', RawTextBody: 'Texte', SpamScore: 0 }] });

  it('répond selon la configuration, le secret et la charge', async () => {
    expect((await handleInboundWebhook(db, media, null, 'x', body(), NOW)).status).toBe(503);
    expect((await handleInboundWebhook(db, media, config, 'mauvais', body(), NOW)).status).toBe(404);
    expect((await handleInboundWebhook(db, media, config, config.webhookSecret, '{', NOW)).status).toBe(400);
    expect((await handleInboundWebhook(db, media, config, config.webhookSecret, 'x'.repeat(2 * 1024 * 1024 + 1), NOW)).status).toBe(413);
  });

  it('crée l’idée et compte les e-mails écartés', async () => {
    expect(await handleInboundWebhook(db, media, config, config.webhookSecret, body(), NOW)).toEqual({ status: 200, body: { received: true, created: 1, ignored: 0 } });
    const unknown = JSON.stringify({ items: [{ MessageId: '<x>', From: { Address: 'a@b.test' }, To: [{ Address: 'autre@b.test' }], Subject: 'S', RawTextBody: 'T' }] });
    expect(await handleInboundWebhook(db, media, config, config.webhookSecret, unknown, NOW)).toEqual({ status: 200, body: { received: true, created: 0, ignored: 1 } });
  });
});

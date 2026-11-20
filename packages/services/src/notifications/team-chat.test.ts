import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, RefusedError } from '../errors.ts';
import { checkChatWebhook, enqueueTeamChat, getTeamChat, removeTeamChat, setTeamChat, teamChatPayload, teamChatText, testTeamChat } from './team-chat.ts';

const NOW = new Date('2026-11-20T10:00:00Z');
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX';
const TEAMS = 'https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=secret';
// Chiffrement simulé : réversible, lié à l'espace.
const cipher = { encrypt: (plain: string, bound: string) => new TextEncoder().encode(`${bound}|${plain}`) };

let db: Database;
let workspaceId: string;
let admin: string;
let editor: string;

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db);
  workspaceId = org.workspaceIds[0] as string;
  admin = await createUser(db, 'admin-messagerie');
  editor = await createUser(db, 'editeur-messagerie');
  await addMember(db, workspaceId, admin, 'admin');
  await addMember(db, workspaceId, editor, 'editor');
});
afterAll(() => closeTestDatabase(db));

describe('adresses de webhook admises', () => {
  it('Slack et Teams officiels seulement, en HTTPS', () => {
    expect(checkChatWebhook('slack', SLACK).hostname).toBe('hooks.slack.com');
    expect(checkChatWebhook('teams', TEAMS).hostname).toBe('prod-12.westeurope.logic.azure.com');
    expect(checkChatWebhook('teams', 'https://contoso.webhook.office.com/webhookb2/x').hostname).toBe('contoso.webhook.office.com');
    for (const [provider, url] of [
      ['slack', 'http://hooks.slack.com/services/x'],
      ['slack', 'https://hooks.slack.com.evil.example/services/x'],
      ['slack', TEAMS],
      ['teams', SLACK],
      ['teams', 'https://127.0.0.1/hook'],
      ['slack', 'pas une adresse'],
    ] as const) {
      expect(() => checkChatWebhook(provider, url), url).toThrow(RefusedError);
    }
  });
});

describe('réglage de la messagerie d’équipe', () => {
  it('réservé aux administrateurs ; adresse chiffrée, jamais réaffichée', async () => {
    await expect(setTeamChat(db, cipher, editor, workspaceId, { provider: 'slack', url: SLACK, events: ['a_valider'] }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTeamChat(db, editor, workspaceId)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getTeamChat(db, admin, workspaceId)).toBeNull();

    await setTeamChat(db, cipher, admin, workspaceId, { provider: 'slack', url: SLACK, events: ['a_valider', 'publies', 'inconnu'] }, NOW);
    const chat = await getTeamChat(db, admin, workspaceId);
    expect(chat).toMatchObject({ provider: 'slack', events: ['a_valider', 'publies'], lastSentAt: null, lastError: null });
    expect(chat?.urlHint).toBe('hooks.slack.com/services/T0…');
    expect(JSON.stringify(chat)).not.toContain('XXXXXXXX');
    const stored = await asSystem(db, (trx) => trx.selectFrom('workspace_chat_hooks').select('url_enc').where('workspace_id', '=', workspaceId).executeTakeFirstOrThrow());
    expect(new TextDecoder().decode(stored.url_enc)).toBe(`chat:${workspaceId}|${SLACK}`);
  });

  it('adresse vide : seuls les événements changent ; changer de messagerie demande une adresse', async () => {
    await setTeamChat(db, cipher, admin, workspaceId, { provider: 'slack', url: '', events: ['erreurs'] }, NOW);
    expect((await getTeamChat(db, admin, workspaceId))?.events).toEqual(['erreurs']);
    await expect(setTeamChat(db, cipher, admin, workspaceId, { provider: 'teams', url: '', events: [] }, NOW)).rejects.toMatchObject({ code: 'messagerie_adresse' });
    await expect(setTeamChat(db, cipher, admin, workspaceId, { provider: 'fax', url: SLACK, events: [] }, NOW)).rejects.toMatchObject({ code: 'choix_inconnu' });
  });

  it('file des messages : seulement les événements choisis ; essai ; retrait', async () => {
    const queued = () => asSystem(db, (trx) => trx.selectFrom('chat_messages').select(['event', 'status']).where('workspace_id', '=', workspaceId).orderBy('id').execute());
    expect(await asSystem(db, (trx) => enqueueTeamChat(trx, workspaceId, 'a_valider', { count: 2 }))).toBe(false);
    expect(await asSystem(db, (trx) => enqueueTeamChat(trx, workspaceId, 'erreurs', { postId: 'x', message: 'LinkedIn indisponible' }))).toBe(true);
    await testTeamChat(db, admin, workspaceId, NOW);
    expect(await queued()).toEqual([
      { event: 'erreurs', status: null },
      { event: 'essai', status: null },
    ]);
    await removeTeamChat(db, admin, workspaceId, NOW);
    expect(await getTeamChat(db, admin, workspaceId)).toBeNull();
    expect(await queued()).toEqual([]);
    await expect(testTeamChat(db, admin, workspaceId, NOW)).rejects.toMatchObject({ code: 'messagerie_absente' });
  });
});

describe('textes des messages', () => {
  const ctx = { appUrl: 'https://app.example', workspaceName: 'Secutop', post: { accountName: 'Page Secutop', excerpt: 'Trois idées reçues' } };

  it('posts à valider, échec, post publié à relayer, essai', () => {
    expect(teamChatText('a_valider', { count: 3 }, ctx)).toEqual({
      text: 'Secutop : 3 posts prêts à valider. Chacun valide les siens depuis « Mes posts », en quelques secondes.',
      link: { label: 'Voir mes posts', url: 'https://app.example/' },
    });
    expect(teamChatText('a_valider', {}, ctx)?.text).toContain('1 post prêt à valider');
    expect(teamChatText('erreurs', { postId: 'p1', message: 'jeton expiré' }, ctx)).toEqual({
      text: 'Secutop : un post de Page Secutop n’a pas pu être publié (jeton expiré).',
      link: { label: 'Voir le post', url: 'https://app.example/posts/p1' },
    });
    expect(teamChatText('erreurs', {}, { ...ctx, post: null })).toMatchObject({ text: expect.stringContaining('erreur inconnue'), link: null });
    const published = teamChatText('publies', { url: 'https://www.linkedin.com/feed/update/urn:li:share:1' }, ctx);
    expect(published?.text).toContain('Nouveau post publié par Page Secutop « Trois idées reçues »');
    expect(published?.link?.url).toBe('https://www.linkedin.com/feed/update/urn:li:share:1');
    expect(teamChatText('publies', { url: 'javascript:alert(1)' }, { ...ctx, post: null })?.link).toBeNull();
    expect(teamChatText('essai', {}, ctx)?.text).toContain('bien reliée');
    expect(teamChatText('autre', {}, ctx)).toBeNull();
  });

  it('format Slack (liens échappés) et carte adaptative Teams', () => {
    const message = { text: 'A <b> & c', link: { label: 'Voir', url: 'https://app.example/' } };
    expect(teamChatPayload('slack', message)).toEqual({ text: 'A &lt;b&gt; &amp; c\n<https://app.example/|Voir>' });
    expect(teamChatPayload('slack', { text: 'Essai', link: null })).toEqual({ text: 'Essai' });
    const teams = teamChatPayload('teams', message) as { attachments: { content: { body: unknown[]; actions?: unknown[] } }[] };
    expect(teams.attachments[0]?.content.body).toEqual([{ type: 'TextBlock', text: 'A <b> & c', wrap: true }]);
    expect(teams.attachments[0]?.content.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Voir', url: 'https://app.example/' }]);
    expect((teamChatPayload('teams', { text: 'Essai', link: null }) as typeof teams).attachments[0]?.content.actions).toBeUndefined();
  });
});

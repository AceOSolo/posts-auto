import { randomBytes } from 'node:crypto';
import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { setTeamChat } from '@posts-auto/services';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenCipher } from '../secrets/token-cipher.ts';
import { MAX_CHAT_ATTEMPTS, runChatDispatch } from './chat-dispatch.ts';
import { notify } from './recipients.ts';

const NOW = new Date('2026-11-20T10:00:00Z');
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX';
const cipher = new TokenCipher(new Map([['k1', randomBytes(32)]]), 'k1');

let db: Database;
let workspaceId: string;
let otherWorkspace: string;
let admin: string;
let postId: string;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}
const recorder = (status = 200) => {
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response('ok', { status });
  }) as unknown as typeof fetch;
  return { sent, fetcher };
};
const messages = () => asSystem(db, (trx) => trx.selectFrom('chat_messages').select(['event', 'status', 'attempts', 'last_error']).orderBy('id').execute());

beforeAll(async () => {
  db = await openTestDatabase();
  const org = await createOrganization(db, { workspaces: 2 });
  workspaceId = org.workspaceIds[0] as string;
  otherWorkspace = org.workspaceIds[1] as string;
  admin = await createUser(db, 'admin-canal');
  await addMember(db, workspaceId, admin, 'admin');
  const accountId = await createAccount(db, workspaceId, { display_name: 'Page Secutop' });
  postId = await createPost(db, workspaceId, accountId, { body: 'Trois idées reçues sur le défibrillateur.\n\nLa suite du post.' });
  await setTeamChat(db, cipher, admin, workspaceId, { provider: 'slack', url: SLACK, events: ['a_valider', 'erreurs', 'publies'] }, NOW);
});
afterAll(() => closeTestDatabase(db));
beforeEach(async () => {
  await asSystem(db, (trx) => trx.deleteFrom('chat_messages').execute());
});

describe('messagerie d’équipe : envoi par le worker', () => {
  it('un message par événement (pas un par personne), seulement pour l’espace relié', async () => {
    await asSystem(db, async (trx) => {
      await notify(trx, [admin, admin], workspaceId, 'posts_prets', { workspaceId, count: 4 }, ['in_app']);
      await notify(trx, [admin], workspaceId, 'publication_erreur', { postId, message: 'LinkedIn indisponible' }, ['email']);
      await notify(trx, [admin], workspaceId, 'recap_hebdo', { count: 1 }, ['email']);
      await notify(trx, [admin], otherWorkspace, 'posts_prets', { count: 1 }, ['in_app']);
    });
    expect((await messages()).map((m) => m.event)).toEqual(['a_valider', 'erreurs']);

    const { sent, fetcher } = recorder();
    const report = await runChatDispatch({ db, cipher, appUrl: 'https://app.example', fetch: fetcher, clock: () => NOW });
    expect(report.sent).toHaveLength(2);
    expect(sent.map((s) => s.url)).toEqual([SLACK, SLACK]);
    expect(String(sent[0]?.body['text'])).toMatch(/ : 4 posts prêts à valider\. Chacun valide les siens depuis « Mes posts », en quelques secondes\.\n<https:\/\/app\.example\/\|Voir mes posts>$/);
    expect(String(sent[1]?.body['text'])).toContain('un post de Page Secutop n’a pas pu être publié (LinkedIn indisponible)');
    expect((await messages()).every((m) => m.status === 'sent')).toBe(true);
    const hook = await asSystem(db, (trx) => trx.selectFrom('workspace_chat_hooks').select(['last_sent_at', 'last_error']).where('workspace_id', '=', workspaceId).executeTakeFirstOrThrow());
    expect(hook).toEqual({ last_sent_at: NOW, last_error: null });
  });

  it('post publié : extrait de la première ligne et lien LinkedIn', async () => {
    await asSystem(db, (trx) => trx.insertInto('chat_messages').values({ workspace_id: workspaceId, event: 'publies', payload: JSON.stringify({ postId, url: 'https://www.linkedin.com/feed/' }) }).execute());
    const { sent, fetcher } = recorder();
    await runChatDispatch({ db, cipher, appUrl: 'https://app.example', fetch: fetcher, clock: () => NOW });
    expect(String(sent[0]?.body['text'])).toContain('Nouveau post publié par Page Secutop « Trois idées reçues sur le défibrillateur. »');
    expect(String(sent[0]?.body['text'])).toContain('<https://www.linkedin.com/feed/|Ouvrir sur LinkedIn>');
  });

  it('erreur passagère : nouvel essai, puis échec après 5 essais ; refus définitif signalé dans les réglages', async () => {
    await asSystem(db, (trx) => trx.insertInto('chat_messages').values({ workspace_id: workspaceId, event: 'essai', created_at: NOW }).execute());
    const busy = recorder(503);
    for (let i = 1; i < MAX_CHAT_ATTEMPTS; i += 1) {
      expect((await runChatDispatch({ db, cipher, appUrl: 'https://app.example', fetch: busy.fetcher, clock: () => NOW })).retrying).toHaveLength(1);
    }
    expect((await runChatDispatch({ db, cipher, appUrl: 'https://app.example', fetch: busy.fetcher, clock: () => NOW })).failed).toHaveLength(1);
    expect((await messages())[0]).toMatchObject({ status: 'failed', attempts: MAX_CHAT_ATTEMPTS });

    await asSystem(db, (trx) => trx.insertInto('chat_messages').values({ workspace_id: workspaceId, event: 'essai', created_at: NOW }).execute());
    const gone = recorder(404);
    expect((await runChatDispatch({ db, cipher, appUrl: 'https://app.example', fetch: gone.fetcher, clock: () => NOW })).failed).toHaveLength(1);
    const hook = await asSystem(db, (trx) => trx.selectFrom('workspace_chat_hooks').select('last_error').where('workspace_id', '=', workspaceId).executeTakeFirstOrThrow());
    expect(hook.last_error).toMatch(/supprimé ou révoqué \(HTTP 404\)/);
  });

  it('réseau injoignable : nouvel essai ; message périmé ou messagerie retirée : écarté', async () => {
    await asSystem(db, (trx) =>
      trx
        .insertInto('chat_messages')
        .values([
          { workspace_id: workspaceId, event: 'essai', created_at: NOW },
          { workspace_id: workspaceId, event: 'a_valider', created_at: new Date(NOW.getTime() - 2 * 86_400_000) },
          { workspace_id: otherWorkspace, event: 'essai', created_at: NOW },
        ])
        .execute(),
    );
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const report = await runChatDispatch({ db, cipher, appUrl: 'https://app.example', fetch: down, clock: () => NOW });
    expect(report).toMatchObject({ stale: 1, retrying: [expect.any(String)], failed: [] });
    expect((await messages()).map((m) => [m.status, m.last_error])).toEqual([
      [null, 'Messagerie injoignable : fetch failed'],
      ['skipped', 'Périmé : non envoyé'],
      ['skipped', 'Messagerie retirée'],
    ]);
  });
});

import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createOrganization, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { listIdeas, listPostRequests } from '../requests/ideas-requests.ts';
import { type ApiKeyContext, authenticateApiKey, createApiKey } from './api-keys.ts';
import { importIdea, importPostRequest } from './inputs.ts';

let db: Database;
let workspaceId: string;
let otherWorkspace: string;
let ctx: ApiKeyContext;
let otherCtx: ApiKeyContext;
let postsOnly: ApiKeyContext;
let jp: string;
let member: string;
let memberEmail: string;
const NOW = new Date('2026-11-16T09:00:00Z');

async function keyFor(ws: string, scopes: Parameters<typeof createApiKey>[1]['scopes']): Promise<ApiKeyContext> {
  const { key } = await createApiKey(db, { workspaceId: ws, name: 'Reprise', scopes });
  const context = await authenticateApiKey(db, key, NOW);
  if (context === null) throw new Error('clé refusée');
  return context;
}

beforeAll(async () => {
  db = await openTestDatabase();
  workspaceId = (await createOrganization(db)).workspaceIds[0] as string;
  otherWorkspace = (await createOrganization(db)).workspaceIds[0] as string;
  member = await createUser(db, 'claire');
  await addMember(db, workspaceId, member, 'contributor');
  memberEmail = (await asSystem(db, (trx) => trx.selectFrom('users').select('email').where('id', '=', member).executeTakeFirstOrThrow())).email;
  jp = await createAccount(db, workspaceId, { display_name: 'JP' });
  ctx = await keyFor(workspaceId, ['inputs:write']);
  otherCtx = await keyFor(otherWorkspace, ['inputs:write']);
  postsOnly = await keyFor(workspaceId, ['posts:write']);
});
afterAll(() => closeTestDatabase(db));

describe('reprise des idées de l’outil actuel', () => {
  it('crée l’idée avec son statut et ses comptes ; la même référence ne crée pas de doublon', async () => {
    const first = await importIdea(db, ctx, { reference: 'idee-42', title: ' Salon Preventica ', details: 'Stand B12', eventOn: '2026-12-08', accountIds: [jp], status: 'retenue', followup: 'À relayer' });
    expect(first.created).toBe(true);
    expect(await importIdea(db, ctx, { reference: 'idee-42', title: 'Autre titre' })).toEqual({ created: false, id: first.id });
    const idea = (await listIdeas(db, member, workspaceId, ['kept'])).ideas.find((i) => i.id === first.id);
    expect(idea).toMatchObject({ title: 'Salon Preventica', eventOn: '2026-12-08', accountIds: [jp], status: 'kept', followup: 'À relayer' });
  });

  it('contrôles : droit de la clé, compte étranger, date, référence ; une clé ne touche que son espace', async () => {
    await expect(importIdea(db, postsOnly, { reference: 'x', title: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(importIdea(db, ctx, { reference: 'x1', title: 'x', accountIds: ['00000000-0000-0000-0000-000000000000'] })).rejects.toMatchObject({ code: 'unknown_account' });
    await expect(importIdea(db, ctx, { reference: 'x2', title: 'x', startsOn: '2026-02-30' })).rejects.toMatchObject({ code: 'date_invalide' });
    await expect(importIdea(db, ctx, { reference: 'avec espace', title: 'x' })).rejects.toMatchObject({ code: 'invalid_reference' });
    await expect(importIdea(db, otherCtx, { reference: 'x3', title: 'x', accountIds: [jp] })).rejects.toMatchObject({ code: 'unknown_account' });
    // Même référence dans un autre espace : une autre idée.
    expect((await importIdea(db, otherCtx, { reference: 'idee-42', title: 'Idée de B' })).created).toBe(true);
  });
});

describe('reprise des demandes de l’outil actuel', () => {
  it('demandeur reconnu par son adresse, ou gardé par son nom ; une demande traitée l’est déjà', async () => {
    const byMember = await importPostRequest(db, ctx, { reference: 'dem-1', text: 'Post sur la salle', accountIds: [jp], requesterEmail: memberEmail.toUpperCase(), status: 'traitee', followup: 'Publié le 3/11' }, NOW);
    const byName = await importPostRequest(db, ctx, { reference: 'dem-2', text: 'Post sur le salon', accountIds: [jp], requesterName: 'Jean-Pierre (ancien outil)', wishedAt: new Date('2026-11-24T11:00:00Z') }, NOW);
    expect(await importPostRequest(db, ctx, { reference: 'dem-1', text: 'x', accountIds: [jp], requesterName: 'x' }, NOW)).toEqual({ created: false, id: byMember.id });

    const { requests } = await listPostRequests(db, member, workspaceId);
    expect(requests.find((r) => r.id === byMember.id)).toMatchObject({ status: 'done', isMine: true, followup: 'Publié le 3/11' });
    expect(requests.find((r) => r.id === byName.id)).toMatchObject({ status: 'new', isMine: false, authorName: 'Jean-Pierre (ancien outil)' });
    const processed = await asSystem(db, (trx) => trx.selectFrom('post_requests').select(['id', 'processed_at']).where('id', 'in', [byMember.id, byName.id]).execute());
    expect(processed.find((r) => r.id === byMember.id)?.processed_at).toEqual(NOW);
    expect(processed.find((r) => r.id === byName.id)?.processed_at).toBeNull();
  });

  it('contrôles : texte, comptes, demandeur', async () => {
    await expect(importPostRequest(db, ctx, { reference: 'd1', text: ' ', accountIds: [jp], requesterName: 'x' }, NOW)).rejects.toMatchObject({ code: 'demande_vide' });
    await expect(importPostRequest(db, ctx, { reference: 'd2', text: 'x', accountIds: [], requesterName: 'x' }, NOW)).rejects.toMatchObject({ code: 'compte_requis' });
    await expect(importPostRequest(db, ctx, { reference: 'd3', text: 'x', accountIds: [jp], requesterEmail: 'inconnu@exemple.test' }, NOW)).resolves.toMatchObject({ created: true });
    await expect(importPostRequest(db, ctx, { reference: 'd4', text: 'x', accountIds: [jp] }, NOW)).rejects.toMatchObject({ code: 'demandeur_requis' });
    await expect(importPostRequest(db, postsOnly, { reference: 'd5', text: 'x', accountIds: [jp], requesterName: 'x' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

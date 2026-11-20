import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { getOnboarding, pendingOnboardings, saveCompanyInfo, setOnboardingClosed } from './onboarding.ts';
import { confirmSignup, requestSignup } from './signup.ts';

let db: Database;
let owner: string;
let workspaceId: string;
let viewer: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const doneKeys = async () => (await getOnboarding(db, owner, workspaceId)).steps.filter((s) => s.done).map((s) => s.key);

beforeAll(async () => {
  db = await openTestDatabase();
  const request = await requestSignup(db, { email: 'gerant@exemple.fr', fullName: 'Gérant', orgName: 'Atelier Sûr', orgKind: 'entreprise' }, NOW);
  if (request.kind !== 'confirm') throw new Error(request.kind);
  const outcome = await confirmSignup(db, request.token, NOW);
  if (!outcome.ok) throw new Error('inscription');
  owner = outcome.session.userId;
  workspaceId = outcome.workspaceId;
  viewer = await createUser(db, 'lecteur');
  await addMember(db, workspaceId, viewer, 'viewer');
});
afterAll(() => closeTestDatabase(db));

describe('assistant de démarrage (ONB-03, ONB-08)', () => {
  it('un espace neuf : six étapes à faire, l’indicateur s’affiche', async () => {
    const onboarding = await getOnboarding(db, owner, workspaceId);
    expect(onboarding).toMatchObject({ workspaceName: 'Atelier Sûr', doneCount: 0, closed: false, canManage: true });
    expect(onboarding.steps.map((s) => s.key)).toEqual(['entreprise', 'comptes', 'ligne', 'charte', 'creneaux', 'redaction']);
    expect(await pendingOnboardings(db, owner)).toEqual([{ workspaceId, workspaceName: 'Atelier Sûr', doneCount: 0, total: 6 }]);
  });

  it('étape 1 : l’entreprise, avec un site complété en https', async () => {
    await saveCompanyInfo(db, owner, workspaceId, { name: 'Atelier Sûr SARL', website: 'atelier-sur.fr', sector: 'Menuiserie', size: '10-49' }, NOW);
    const onboarding = await getOnboarding(db, owner, workspaceId);
    expect(onboarding.company).toEqual({ name: 'Atelier Sûr SARL', website: 'https://atelier-sur.fr/', sector: 'Menuiserie', size: '10-49' });
    expect(await doneKeys()).toEqual(['entreprise']);
    await expect(saveCompanyInfo(db, owner, workspaceId, { name: 'X', website: 'http://moi:secret@site.fr', sector: 'S', size: '10-49' }, NOW)).rejects.toMatchObject({ code: 'entreprise_site' });
    await expect(saveCompanyInfo(db, owner, workspaceId, { name: 'X', website: '', sector: 'S', size: '1000' }, NOW)).rejects.toMatchObject({ code: 'entreprise_taille' });
    await expect(saveCompanyInfo(db, viewer, workspaceId, { name: 'X', website: '', sector: 'S', size: '1-9' }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('les étapes faites ailleurs dans l’application comptent', async () => {
    const account = await createAccount(db, workspaceId, { holder_user_id: owner });
    expect(await doneKeys()).toEqual(['entreprise', 'comptes']);
    // Créneaux : le compte a un titulaire, il lui faut un créneau habituel.
    expect((await getOnboarding(db, owner, workspaceId)).steps.find((s) => s.key === 'creneaux')?.detail).toMatch(/1 compte sans créneau/);
    await asSystem(db, async (trx) => {
      await trx.insertInto('account_profiles').values({ account_id: account, workspace_id: workspaceId, usual_slots: JSON.stringify([{ weekday: 2, time: '12:00' }]) }).execute();
      await trx.insertInto('editorial_lines').values({ workspace_id: workspaceId, version: 1, rules: '{}' }).execute();
      await trx.updateTable('workspaces').set({ branding: JSON.stringify({ primary: '#123456' }) }).where('id', '=', workspaceId).execute();
    });
    expect(await doneKeys()).toEqual(['entreprise', 'comptes', 'ligne', 'charte', 'creneaux']);
    await asSystem(db, (trx) => trx.insertInto('generation_runs').values({ workspace_id: workspaceId, kind: 'weekly', status: 'done', finished_at: NOW }).execute());
    expect((await getOnboarding(db, owner, workspaceId)).doneCount).toBe(6);
    // Tout est fait : plus d'indicateur.
    expect(await pendingOnboardings(db, owner)).toEqual([]);
  });

  it('l’assistant se ferme et se rouvre ; un lecteur le voit sans pouvoir le modifier', async () => {
    await setOnboardingClosed(db, owner, workspaceId, true, NOW);
    expect((await getOnboarding(db, owner, workspaceId)).closed).toBe(true);
    await setOnboardingClosed(db, owner, workspaceId, false, NOW);
    expect((await getOnboarding(db, viewer, workspaceId)).canManage).toBe(false);
    await expect(setOnboardingClosed(db, viewer, workspaceId, true, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await pendingOnboardings(db, viewer)).toEqual([]);
  });
});

import { type Database, asSystem } from '@posts-auto/db';
import { addMember, closeTestDatabase, createAccount, createPost, createUser, openTestDatabase } from '@posts-auto/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '../errors.ts';
import { applySuggestedSlots, getOnboarding, launchFirstGeneration, pendingOnboardings, saveCompanyInfo, setOnboardingClosed, suggestedSlots } from './onboarding.ts';
import { confirmSignup, requestSignup } from './signup.ts';

let db: Database;
let owner: string;
let workspaceId: string;
let viewer: string;
const NOW = new Date('2026-11-20T10:00:00Z');
const doneKeys = async () => (await getOnboarding(db, owner, workspaceId)).steps.filter((s) => s.done).map((s) => s.key);
async function newWorkspace(email: string): Promise<{ userId: string; workspaceId: string }> {
  const request = await requestSignup(db, { email, fullName: 'Autre', orgName: 'Autre atelier', orgKind: 'entreprise' }, NOW);
  if (request.kind !== 'confirm') throw new Error(request.kind);
  const outcome = await confirmSignup(db, request.token, NOW);
  if (!outcome.ok) throw new Error('inscription');
  return { userId: outcome.session.userId, workspaceId: outcome.workspaceId };
}

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
  it('un espace neuf : cinq étapes dans l’ordre, l’indicateur s’affiche', async () => {
    const onboarding = await getOnboarding(db, owner, workspaceId);
    expect(onboarding).toMatchObject({ workspaceName: 'Atelier Sûr', doneCount: 0, current: 'entreprise', brandDone: false, generation: 'aucune', autoGeneration: false, closed: false, canManage: true });
    expect(onboarding.steps.map((s) => s.key)).toEqual(['entreprise', 'comptes', 'ligne', 'creneaux', 'redaction']);
    expect(await pendingOnboardings(db, owner)).toEqual([{ workspaceId, workspaceName: 'Atelier Sûr', doneCount: 0, total: 5 }]);
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
    expect(await doneKeys()).toEqual(['entreprise', 'comptes', 'ligne', 'creneaux']);
    // La charte est facultative : enregistrée, elle ne compte pas dans l'avancement.
    expect(await getOnboarding(db, owner, workspaceId)).toMatchObject({ brandDone: true, doneCount: 4, current: 'redaction' });
    // Une rédaction échouée ne termine pas l'étape.
    await asSystem(db, (trx) => trx.insertInto('generation_runs').values({ workspace_id: workspaceId, kind: 'weekly', status: 'failed', started_at: NOW, finished_at: NOW }).execute());
    expect(await getOnboarding(db, owner, workspaceId)).toMatchObject({ generation: 'echec', doneCount: 4, current: 'redaction' });
    await asSystem(db, (trx) => trx.insertInto('generation_runs').values({ workspace_id: workspaceId, kind: 'weekly', status: 'done', finished_at: NOW }).execute());
    expect(await getOnboarding(db, owner, workspaceId)).toMatchObject({ generation: 'faite', doneCount: 5, current: null });
    // Tout est fait : plus d'indicateur.
    expect(await pendingOnboardings(db, owner)).toEqual([]);
  });

  it('un compte déconnecté ne compte plus comme connecté', async () => {
    const other = await newWorkspace('revoque@exemple.fr');
    await createAccount(db, other.workspaceId, { holder_user_id: other.userId, status: 'revoked' });
    expect((await getOnboarding(db, other.userId, other.workspaceId)).steps.find((s) => s.key === 'comptes')?.done).toBe(false);
  });

  it('créneaux conseillés : un par post de la semaine, sans écraser ceux déjà choisis', async () => {
    expect(suggestedSlots(1)).toEqual([{ weekday: 2, time: '09:00' }]);
    expect(suggestedSlots(3).map((s) => s.weekday)).toEqual([2, 3, 4]);
    expect(suggestedSlots(14)).toHaveLength(5);
    const other = await newWorkspace('creneaux@exemple.fr');
    const empty = await createAccount(db, other.workspaceId, { holder_user_id: other.userId });
    const chosen = await createAccount(db, other.workspaceId, { holder_user_id: other.userId });
    const mine = JSON.stringify([{ weekday: 5, time: '16:00' }]);
    await asSystem(db, (trx) => trx.insertInto('account_profiles').values({ account_id: chosen, workspace_id: other.workspaceId, usual_slots: mine }).execute());
    expect(await applySuggestedSlots(db, other.userId, other.workspaceId, NOW)).toBe(1);
    const slots = await asSystem(db, (trx) => trx.selectFrom('account_profiles').select(['account_id', 'usual_slots']).where('workspace_id', '=', other.workspaceId).execute());
    expect(slots.find((s) => s.account_id === empty)?.usual_slots).toEqual([{ weekday: 2, time: '09:00' }]);
    expect(slots.find((s) => s.account_id === chosen)?.usual_slots).toEqual([{ weekday: 5, time: '16:00' }]);
    expect((await getOnboarding(db, other.userId, other.workspaceId)).steps.find((s) => s.key === 'creneaux')?.done).toBe(true);
  });

  it('première rédaction : demandée, et celle de chaque semaine activée pour un nouvel espace', async () => {
    const other = await newWorkspace('premiere@exemple.fr');
    expect(await launchFirstGeneration(db, other.userId, other.workspaceId, NOW)).toEqual({ weekly: true });
    expect(await getOnboarding(db, other.userId, other.workspaceId)).toMatchObject({ generation: 'demandee', autoGeneration: true });
  });

  it('première rédaction : la rédaction hebdomadaire reste coupée si l’espace a déjà des posts (bascule)', async () => {
    const other = await newWorkspace('bascule@exemple.fr');
    const account = await createAccount(db, other.workspaceId, { holder_user_id: other.userId });
    await createPost(db, other.workspaceId, account);
    expect(await launchFirstGeneration(db, other.userId, other.workspaceId, NOW)).toEqual({ weekly: false });
    expect(await getOnboarding(db, other.userId, other.workspaceId)).toMatchObject({ generation: 'demandee', autoGeneration: false });
  });

  it('première rédaction : un éditeur la lance sans activer la rédaction hebdomadaire', async () => {
    const other = await newWorkspace('proprietaire@exemple.fr');
    const editor = await createUser(db, 'editeur-demarrage');
    await addMember(db, other.workspaceId, editor, 'editor');
    expect(await launchFirstGeneration(db, editor, other.workspaceId, NOW)).toEqual({ weekly: false });
    expect((await getOnboarding(db, other.userId, other.workspaceId)).autoGeneration).toBe(false);
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

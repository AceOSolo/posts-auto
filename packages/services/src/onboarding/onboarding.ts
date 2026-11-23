/**
 * Assistant de démarrage (ONB-03) et indicateur « prêt à publier » (ONB-08).
 *
 * Cinq étapes, dans l'ordre : 1) l'entreprise (nom, site, secteur, taille) ; 2) les comptes
 * LinkedIn ; 3) la ligne éditoriale ; 4) les créneaux et les validateurs ; 5) la première
 * rédaction. La charte visuelle est facultative : elle ne compte pas dans l'avancement.
 * L'avancement est calculé à partir des données de l'espace, pas enregistré : l'assistant se
 * reprend à tout moment, et une étape faite ailleurs dans l'application compte aussi. Seule
 * la fermeture de l'assistant est enregistrée.
 */
import type { IsoWeekday, UsualSlot } from '@posts-auto/core';
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { saveAccountProfile } from '../editorial/account-profiles.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';
import { configureGeneration, requestGeneration } from '../planning/generation.ts';
import { type SamplePost, parseSamplePost } from './sample-post.ts';

export const COMPANY_SIZES = ['1-9', '10-49', '50-249', '250+'] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

export type OnboardingStepKey = 'entreprise' | 'comptes' | 'ligne' | 'creneaux' | 'redaction';
export const ONBOARDING_STEP_KEYS: readonly OnboardingStepKey[] = ['entreprise', 'comptes', 'ligne', 'creneaux', 'redaction'];

/** Où en est la première rédaction : elle prend plusieurs minutes et peut échouer. */
export type GenerationProgress = 'aucune' | 'demandee' | 'en_cours' | 'echec' | 'faite';

export interface OnboardingStep {
  readonly key: OnboardingStepKey;
  readonly title: string;
  readonly done: boolean;
  /** Ce qui reste à faire, ou ce qui est fait. */
  readonly detail: string;
  /** Page de l'application où se fait l'étape (null : dans l'assistant). */
  readonly href: string | null;
}

/** Compte à qui il manque un créneau habituel ou une personne pour valider. */
export interface AccountToFinish {
  readonly id: string;
  readonly name: string;
  readonly needsSlots: boolean;
  readonly needsValidator: boolean;
  /** Créneaux conseillés, selon le rythme du compte. */
  readonly suggestedSlots: readonly UsualSlot[];
}

export interface Onboarding {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly company: { readonly name: string; readonly website: string | null; readonly sector: string | null; readonly size: CompanySize | null };
  readonly steps: readonly OnboardingStep[];
  readonly doneCount: number;
  /** Première étape qui reste à faire (null : tout est fait). */
  readonly current: OnboardingStepKey | null;
  /** Charte visuelle enregistrée (facultative). */
  readonly brandDone: boolean;
  readonly generation: GenerationProgress;
  /** La rédaction de chaque semaine est activée. */
  readonly autoGeneration: boolean;
  /** Lancer la première rédaction activera aussi celle de chaque semaine. */
  readonly weeklyOnLaunch: boolean;
  readonly accountsToFinish: readonly AccountToFinish[];
  /** L'assistant a été terminé ou fermé. */
  readonly closed: boolean;
  readonly canManage: boolean;
  /** Dernier post d'exemple rédigé à partir du site (jamais publié). */
  readonly samplePost: SamplePost | null;
}

/** Jours conseillés, du meilleur au moins bon, à 9 h (dans les heures autorisées par défaut). */
const SUGGESTED_DAYS: readonly IsoWeekday[] = [2, 4, 3, 1, 5];

/** Créneaux conseillés pour un rythme donné : un par post de la semaine, cinq au plus. */
export function suggestedSlots(postsPerWeek: number): UsualSlot[] {
  const count = Math.min(Math.max(postsPerWeek, 1), SUGGESTED_DAYS.length);
  return SUGGESTED_DAYS.slice(0, count)
    .map((weekday) => ({ weekday, time: '09:00' }))
    .sort((a, b) => a.weekday - b.weekday);
}

async function requireRole(trx: Tx, userId: string, workspaceId: string) {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

async function computeSteps(trx: Tx, workspaceId: string) {
  const ws = encodeURIComponent(workspaceId);
  const workspace = await trx
    .selectFrom('workspaces')
    .select(['name', 'website', 'sector', 'company_size', 'branding', 'onboarding_done_at', 'sample_post', 'generation_requested_at', 'auto_generation'])
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  const accounts = await trx
    .selectFrom('social_accounts as a')
    .leftJoin('account_profiles as p', 'p.account_id', 'a.id')
    .select([
      'a.id',
      'a.display_name',
      'a.holder_user_id',
      'p.posts_per_week',
      sql<number>`coalesce(jsonb_array_length(p.usual_slots), 0)`.as('slots'),
      (eb) => eb.exists(eb.selectFrom('account_delegates as d').select('d.user_id').whereRef('d.account_id', '=', 'a.id')).as('has_delegate'),
    ])
    .where('a.workspace_id', '=', workspaceId)
    .where('a.status', '<>', 'revoked')
    .execute();
  const editorial = await trx.selectFrom('editorial_lines').select('id').where('workspace_id', '=', workspaceId).limit(1).executeTakeFirst();
  const latestRun = await trx.selectFrom('generation_runs').select(['status', 'started_at']).where('workspace_id', '=', workspaceId).orderBy('started_at', 'desc').limit(1).executeTakeFirst();
  const finishedRun = await trx.selectFrom('generation_runs').select('id').where('workspace_id', '=', workspaceId).where('status', '=', 'done').limit(1).executeTakeFirst();

  const generation: GenerationProgress =
    finishedRun !== undefined
      ? 'faite'
      : latestRun?.status === 'running'
        ? 'en_cours'
        : workspace.generation_requested_at !== null && (latestRun === undefined || workspace.generation_requested_at.getTime() > latestRun.started_at.getTime())
          ? 'demandee'
          : latestRun?.status === 'failed'
            ? 'echec'
            : 'aucune';

  const accountsToFinish: AccountToFinish[] = accounts
    .map((a) => ({
      id: a.id,
      name: a.display_name ?? 'Compte LinkedIn',
      needsSlots: a.slots === 0,
      needsValidator: a.holder_user_id === null && !a.has_delegate,
      suggestedSlots: suggestedSlots(a.posts_per_week ?? 1),
    }))
    .filter((a) => a.needsSlots || a.needsValidator);
  const unready = accountsToFinish.length;
  const companyDone = workspace.company_size !== null && workspace.sector !== null;

  const steps: OnboardingStep[] = [
    {
      key: 'entreprise',
      title: 'Votre entreprise',
      done: companyDone,
      detail: companyDone ? `${workspace.name} · ${workspace.sector} · ${workspace.company_size} personnes` : 'Nom, site, secteur et taille.',
      href: null,
    },
    {
      key: 'comptes',
      title: 'Comptes LinkedIn',
      done: accounts.length > 0,
      detail: accounts.length > 0 ? `${accounts.length} compte${accounts.length > 1 ? 's' : ''} connecté${accounts.length > 1 ? 's' : ''}.` : 'Connectez au moins un profil ou une page.',
      href: `/comptes/${ws}`,
    },
    {
      key: 'ligne',
      title: 'Ligne éditoriale',
      done: editorial !== undefined,
      detail: editorial !== undefined ? 'Enregistrée.' : 'Positionnement, offres, cibles, ton. L’IA la propose à partir de votre site et de vos posts ; vous corrigez puis validez.',
      href: editorial !== undefined ? `/ligne/${ws}` : `/ligne/${ws}#proposer`,
    },
    {
      key: 'creneaux',
      title: 'Créneaux et validateurs',
      done: accounts.length > 0 && unready === 0,
      detail:
        accounts.length === 0
          ? 'Après la connexion des comptes.'
          : unready === 0
            ? 'Chaque compte a ses créneaux et quelqu’un pour valider.'
            : `${unready} compte${unready > 1 ? 's' : ''} sans créneau habituel ou sans personne pour valider.`,
      href: `/comptes/${ws}`,
    },
    {
      key: 'redaction',
      title: 'Première rédaction',
      done: generation === 'faite',
      detail:
        generation === 'faite'
          ? 'Faite : les posts attendent leur validation.'
          : generation === 'echec'
            ? 'La dernière rédaction n’a pas abouti.'
            : generation === 'aucune'
              ? 'L’IA rédige les posts des deux prochaines semaines.'
              : 'L’IA rédige vos posts.',
      href: `/planning/${ws}/redactions`,
    },
  ];
  return { steps, workspace, generation, accountsToFinish };
}

export async function getOnboarding(db: Database, userId: string, workspaceId: string): Promise<Onboarding> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    const { steps, workspace, generation, accountsToFinish } = await computeSteps(trx, workspaceId);
    const post = await trx.selectFrom('posts').select('id').where('workspace_id', '=', workspaceId).limit(1).executeTakeFirst();
    return {
      workspaceId,
      workspaceName: workspace.name,
      company: { name: workspace.name, website: workspace.website, sector: workspace.sector, size: workspace.company_size as CompanySize | null },
      steps,
      doneCount: steps.filter((s) => s.done).length,
      current: steps.find((s) => !s.done)?.key ?? null,
      brandDone: workspace.branding !== null,
      generation,
      autoGeneration: workspace.auto_generation,
      weeklyOnLaunch: !workspace.auto_generation && (role === 'owner' || role === 'admin') && post === undefined,
      accountsToFinish,
      closed: workspace.onboarding_done_at !== null,
      canManage: canManageContent(role),
      samplePost: parseSamplePost(workspace.sample_post),
    };
  });
}

export interface CompanyInput {
  readonly name: string;
  readonly website: string;
  readonly sector: string;
  readonly size: string;
}

/** ONB-03, étape 1 : nom (de l'espace), site, secteur, taille. */
export async function saveCompanyInfo(db: Database, userId: string, workspaceId: string, input: CompanyInput, now: Date): Promise<void> {
  const name = cleanText(input.name, 120);
  if (name === null) throw new RefusedError('entreprise_nom', 'Indiquez le nom.');
  const sector = cleanText(input.sector, 120);
  if (sector === null) throw new RefusedError('entreprise_secteur', 'Indiquez le secteur.');
  if (!COMPANY_SIZES.includes(input.size as CompanySize)) throw new RefusedError('entreprise_taille', 'Choisissez une taille.');
  let website = cleanText(input.website, 300);
  if (website !== null) {
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    try {
      const url = new URL(website);
      if (url.username || url.password || !url.hostname.includes('.')) throw new Error('adresse');
      website = url.toString();
    } catch {
      throw new RefusedError('entreprise_site', 'Adresse du site invalide.');
    }
  }
  await asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editCompany');
    await trx.updateTable('workspaces').set({ name, website, sector, company_size: input.size }).where('id', '=', workspaceId).execute();
    await audit(trx, { workspaceId, actorUserId: userId, action: 'espace.entreprise', entity: 'workspace', entityId: workspaceId, details: { size: input.size }, at: now });
  });
}

/** ONB-03, étape 4 : donne les créneaux conseillés aux comptes qui n'en ont aucun. */
export async function applySuggestedSlots(db: Database, userId: string, workspaceId: string, now: Date): Promise<number> {
  const { accountsToFinish } = await getOnboarding(db, userId, workspaceId);
  const missing = accountsToFinish.filter((account) => account.needsSlots);
  for (const account of missing) await saveAccountProfile(db, userId, account.id, { usualSlots: account.suggestedSlots }, now);
  return missing.length;
}

/**
 * ONB-03, étape 5 : demande la première rédaction et active celle de chaque semaine.
 * L'activation est réservée aux espaces sans aucun post : pendant une bascule (RÈG-21),
 * l'outil précédent rédige encore et deux rédactions produiraient des doublons.
 */
export async function launchFirstGeneration(db: Database, userId: string, workspaceId: string, now: Date): Promise<{ readonly weekly: boolean }> {
  await requestGeneration(db, userId, workspaceId, now);
  const state = await asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    const workspace = await trx.selectFrom('workspaces').select(['auto_generation', 'generation_cron']).where('id', '=', workspaceId).executeTakeFirstOrThrow();
    const post = await trx.selectFrom('posts').select('id').where('workspace_id', '=', workspaceId).limit(1).executeTakeFirst();
    return { role, auto: workspace.auto_generation, cron: workspace.generation_cron, hasPosts: post !== undefined };
  });
  if (state.auto) return { weekly: true };
  if ((state.role !== 'owner' && state.role !== 'admin') || state.hasPosts) return { weekly: false };
  await configureGeneration(db, userId, workspaceId, { auto: true, cron: state.cron }, now);
  return { weekly: true };
}

/** Termine ou ferme l'assistant (il peut être rouvert depuis l'indicateur). */
export async function setOnboardingClosed(db: Database, userId: string, workspaceId: string, closed: boolean, now: Date): Promise<void> {
  await asUser(db, userId, async (trx) => {
    if (!canManageContent(await requireRole(trx, userId, workspaceId))) throw new ForbiddenError('editOnboarding');
    await trx.updateTable('workspaces').set({ onboarding_done_at: closed ? now : null }).where('id', '=', workspaceId).execute();
  });
}

/** ONB-08 : espaces dont l'assistant est en cours, pour l'indicateur « prêt à publier ». */
export async function pendingOnboardings(db: Database, userId: string): Promise<{ workspaceId: string; workspaceName: string; doneCount: number; total: number }[]> {
  return asUser(db, userId, async (trx) => {
    const workspaces = await trx.selectFrom('workspaces').select('id').where('onboarding_done_at', 'is', null).orderBy('created_at').execute();
    const result: { workspaceId: string; workspaceName: string; doneCount: number; total: number }[] = [];
    for (const w of workspaces) {
      if (!canManageContent(await workspaceRole(trx, userId, w.id))) continue;
      const { steps, workspace } = await computeSteps(trx, w.id);
      const doneCount = steps.filter((s) => s.done).length;
      // Toutes les étapes faites : plus besoin de l'indicateur, même si l'assistant n'a pas été fermé.
      if (doneCount < steps.length) result.push({ workspaceId: w.id, workspaceName: workspace.name, doneCount, total: steps.length });
    }
    return result;
  });
}

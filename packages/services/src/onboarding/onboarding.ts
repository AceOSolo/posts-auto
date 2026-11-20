/**
 * Assistant de démarrage (ONB-03) et indicateur « prêt à publier » (ONB-08).
 *
 * Six étapes : 1) l'entreprise (nom, site, secteur, taille) ; 2) les comptes LinkedIn ;
 * 3) la ligne éditoriale ; 4) la charte visuelle ; 5) les créneaux et les validateurs ;
 * 6) la première rédaction. L'avancement est calculé à partir des données de l'espace, pas
 * enregistré : l'assistant se reprend à tout moment, et une étape faite ailleurs dans
 * l'application compte aussi. Seule la fermeture de l'assistant est enregistrée.
 */
import { type Database, type Tx, asUser } from '@posts-auto/db';
import { sql } from 'kysely';
import { canManageContent, workspaceRole } from '../access.ts';
import { audit, cleanText } from '../audit.ts';
import { ForbiddenError, NotFoundError, RefusedError } from '../errors.ts';

export const COMPANY_SIZES = ['1-9', '10-49', '50-249', '250+'] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

export type OnboardingStepKey = 'entreprise' | 'comptes' | 'ligne' | 'charte' | 'creneaux' | 'redaction';

export interface OnboardingStep {
  readonly key: OnboardingStepKey;
  readonly title: string;
  readonly done: boolean;
  /** Ce qui reste à faire, ou ce qui est fait. */
  readonly detail: string;
  /** Page de l'application où se fait l'étape (null : dans l'assistant). */
  readonly href: string | null;
}

export interface Onboarding {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly company: { readonly name: string; readonly website: string | null; readonly sector: string | null; readonly size: CompanySize | null };
  readonly steps: readonly OnboardingStep[];
  readonly doneCount: number;
  /** L'assistant a été terminé ou fermé. */
  readonly closed: boolean;
  readonly canManage: boolean;
}

async function requireRole(trx: Tx, userId: string, workspaceId: string) {
  const role = await workspaceRole(trx, userId, workspaceId);
  if (role === null) throw new NotFoundError('Espace');
  return role;
}

async function computeSteps(trx: Tx, workspaceId: string): Promise<{ steps: OnboardingStep[]; workspace: { name: string; website: string | null; sector: string | null; company_size: string | null; onboarding_done_at: Date | null } }> {
  const ws = encodeURIComponent(workspaceId);
  const workspace = await trx
    .selectFrom('workspaces')
    .select(['name', 'website', 'sector', 'company_size', 'branding', 'onboarding_done_at'])
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  const accounts = await trx
    .selectFrom('social_accounts as a')
    .leftJoin('account_profiles as p', 'p.account_id', 'a.id')
    .select([
      'a.id',
      'a.holder_user_id',
      sql<number>`coalesce(jsonb_array_length(p.usual_slots), 0)`.as('slots'),
      (eb) => eb.exists(eb.selectFrom('account_delegates as d').select('d.user_id').whereRef('d.account_id', '=', 'a.id')).as('has_delegate'),
    ])
    .where('a.workspace_id', '=', workspaceId)
    .execute();
  const editorial = await trx.selectFrom('editorial_lines').select('id').where('workspace_id', '=', workspaceId).limit(1).executeTakeFirst();
  const run = await trx.selectFrom('generation_runs').select('id').where('workspace_id', '=', workspaceId).limit(1).executeTakeFirst();

  const unready = accounts.filter((a) => a.slots === 0 || (a.holder_user_id === null && !a.has_delegate)).length;
  const steps: OnboardingStep[] = [
    {
      key: 'entreprise',
      title: 'Votre entreprise',
      done: workspace.company_size !== null && workspace.sector !== null,
      detail: workspace.company_size !== null && workspace.sector !== null ? `${workspace.name} · ${workspace.sector} · ${workspace.company_size} personnes` : 'Nom, site, secteur et taille.',
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
      detail: editorial !== undefined ? 'Enregistrée.' : 'Positionnement, offres, cibles, ton. L’IA peut la proposer à partir de votre site.',
      href: `/ligne/${ws}`,
    },
    {
      key: 'charte',
      title: 'Charte visuelle',
      done: workspace.branding !== null,
      detail: workspace.branding !== null ? 'Enregistrée.' : 'Couleurs, police des titres et logo des visuels.',
      href: `/visuels/${ws}#charte`,
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
      done: run !== undefined,
      detail: run !== undefined ? 'Faite : les posts attendent leur validation.' : 'L’IA rédige les posts des deux prochaines semaines.',
      href: `/planning/${ws}/redactions`,
    },
  ];
  return { steps, workspace };
}

export async function getOnboarding(db: Database, userId: string, workspaceId: string): Promise<Onboarding> {
  return asUser(db, userId, async (trx) => {
    const role = await requireRole(trx, userId, workspaceId);
    const { steps, workspace } = await computeSteps(trx, workspaceId);
    return {
      workspaceId,
      workspaceName: workspace.name,
      company: { name: workspace.name, website: workspace.website, sector: workspace.sector, size: workspace.company_size as CompanySize | null },
      steps,
      doneCount: steps.filter((s) => s.done).length,
      closed: workspace.onboarding_done_at !== null,
      canManage: canManageContent(role),
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

import { COMPANY_SIZES, NotFoundError, type Onboarding, type OnboardingStepKey, getOnboarding, listMyPosts } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Flash } from '../../../../components/flash.tsx';
import { PostPreview } from '../../../../components/post-preview.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { applySlotsAction, closeOnboardingAction, launchFirstRunAction, openStepAction, prepareLineAction, samplePostAction, saveCompanyAction } from '../actions.ts';
import { AutoRefresh } from './auto-refresh.tsx';
import styles from './demarrage.module.css';

export const metadata: Metadata = { title: 'Démarrage' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZE_LABELS: Record<string, string> = { '1-9': '1 à 9 personnes', '10-49': '10 à 49 personnes', '50-249': '50 à 249 personnes', '250+': '250 personnes ou plus' };
const DAYS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

/** Pour chaque étape : ce qu'il faut faire, pourquoi, et le temps que cela prend. */
const GUIDE: Record<OnboardingStepKey, { heading: string; why: string; time: string }> = {
  entreprise: { heading: 'Présentez votre entreprise', why: 'L’IA s’en sert pour écrire sur votre métier, et non sur un secteur en général.', time: '1 minute' },
  comptes: { heading: 'Connectez votre compte LinkedIn', why: 'C’est là que vos posts seront publiés. Rien ne part sans validation.', time: '1 minute' },
  ligne: { heading: 'Préparez votre ligne éditoriale', why: 'Ce que vous proposez, à qui vous parlez, votre ton. L’IA la prépare à partir de votre site ; vous la corrigez, puis vous l’enregistrez.', time: '3 minutes' },
  creneaux: { heading: 'Choisissez quand publier', why: 'Chaque compte a besoin d’un créneau habituel et d’une personne pour valider ses posts.', time: '1 minute' },
  redaction: { heading: 'Lancez votre première rédaction', why: 'L’IA rédige les posts des deux prochaines semaines. Vous les relirez avant toute publication.', time: 'quelques minutes' },
};

function CompanyFields({ company }: { company: Onboarding['company'] }) {
  return (
    <>
      <label htmlFor="nom">Nom (de l’entreprise, ou du client pour une agence)</label>
      <input id="nom" name="nom" defaultValue={company.name} maxLength={120} required />
      <label htmlFor="site">Site web</label>
      <input id="site" name="site" type="text" inputMode="url" defaultValue={company.website ?? ''} placeholder="www.exemple.fr" maxLength={300} />
      <label htmlFor="secteur">Secteur d’activité</label>
      <input id="secteur" name="secteur" defaultValue={company.sector ?? ''} placeholder="Ex. : prévention des risques professionnels" maxLength={120} required />
      <label htmlFor="taille">Taille</label>
      <select id="taille" name="taille" defaultValue={company.size ?? ''} required>
        <option value="" disabled>
          Choisir
        </option>
        {COMPANY_SIZES.map((size) => (
          <option key={size} value={size}>
            {SIZE_LABELS[size]}
          </option>
        ))}
      </select>
    </>
  );
}

/** Part faire l'étape sur sa page ; la barre de retour ramène ensuite à la suite. */
function OpenStep({ workspaceId, step, target, primary, children }: { workspaceId: string; step: OnboardingStepKey; target: string; primary?: boolean; children: ReactNode }) {
  return (
    <form action={openStepAction.bind(null, workspaceId, step, target)}>
      <button type="submit" className={primary ? 'primary' : 'link'}>
        {children}
      </button>
    </form>
  );
}

function Stepper({ onboarding, active }: { onboarding: Onboarding; active: OnboardingStepKey | 'prise-en-main' }) {
  const { steps, workspaceId, current } = onboarding;
  return (
    <ol className={styles.stepper} aria-label={`${onboarding.doneCount} étapes faites sur ${steps.length}`}>
      {steps.map((step, index) => {
        const isActive = step.key === active;
        const reachable = step.done || step.key === current;
        const content = (
          <>
            <span className={styles.dot} aria-hidden="true">
              {step.done ? '✓' : index + 1}
            </span>
            <span className={styles.stepLabel}>{step.title}</span>
            {step.done && <span className="visually-hidden"> (fait)</span>}
          </>
        );
        return (
          <li key={step.key} className={`${step.done ? styles.stepDone : ''} ${isActive ? styles.stepActive : ''}`} aria-current={isActive ? 'step' : undefined}>
            {reachable && !isActive ? <Link href={`/demarrage/${workspaceId}?etape=${step.key}`}>{content}</Link> : <span className={styles.stepInner}>{content}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function CompanyStep({ onboarding }: { onboarding: Onboarding }) {
  return (
    <form action={saveCompanyAction.bind(null, onboarding.workspaceId)} className="stack">
      <CompanyFields company={onboarding.company} />
      <button type="submit" className="primary">
        Enregistrer et continuer
      </button>
    </form>
  );
}

function AccountsStep({ workspaceId }: { workspaceId: string }) {
  return (
    <>
      <OpenStep workspaceId={workspaceId} step="comptes" target="profil" primary>
        Connecter mon profil LinkedIn
      </OpenStep>
      <details className={styles.more}>
        <summary>Plus d’options</summary>
        <OpenStep workspaceId={workspaceId} step="comptes" target="comptes">
          Connecter plutôt une page d’entreprise
        </OpenStep>
      </details>
    </>
  );
}

function LineStep({ onboarding }: { onboarding: Onboarding }) {
  const { workspaceId, company } = onboarding;
  if (company.website === null) {
    return (
      <>
        <p className="hint">Sans site web renseigné, l’IA s’appuie sur les posts que vous lui collez.</p>
        <OpenStep workspaceId={workspaceId} step="ligne" target="ligne" primary>
          Préparer ma ligne éditoriale
        </OpenStep>
      </>
    );
  }
  return (
    <>
      <form action={prepareLineAction.bind(null, workspaceId)}>
        <button type="submit" className="primary">
          Préparer ma ligne éditoriale
        </button>
      </form>
      <details className={styles.more}>
        <summary>Plus d’options</summary>
        <OpenStep workspaceId={workspaceId} step="ligne" target="ligne">
          Ajouter d’abord mes meilleurs posts, ou la rédiger moi-même
        </OpenStep>
      </details>
    </>
  );
}

function SlotsStep({ onboarding }: { onboarding: Onboarding }) {
  const { workspaceId, accountsToFinish } = onboarding;
  const withoutSlots = accountsToFinish.filter((account) => account.needsSlots);
  const withoutValidator = accountsToFinish.filter((account) => account.needsValidator);
  if (withoutSlots.length > 0) {
    return (
      <>
        <ul className={styles.summary}>
          {withoutSlots.map((account) => (
            <li key={account.id}>
              <strong>{account.name}</strong> : {account.suggestedSlots.map((slot) => `${DAYS[slot.weekday]} à ${Number(slot.time.slice(0, 2))} h`).join(', ')}
            </li>
          ))}
        </ul>
        <form action={applySlotsAction.bind(null, workspaceId)}>
          <button type="submit" className="primary">
            Adopter ces créneaux
          </button>
        </form>
        <details className={styles.more}>
          <summary>Choisir d’autres créneaux</summary>
          <ul className={styles.plain}>
            {withoutSlots.map((account) => (
              <li key={account.id}>
                <OpenStep workspaceId={workspaceId} step="creneaux" target={`fiche:${account.id}`}>
                  {`Régler ${account.name}`}
                </OpenStep>
              </li>
            ))}
          </ul>
        </details>
      </>
    );
  }
  return (
    <>
      <p>
        Il manque une personne pour valider les posts de <strong>{withoutValidator.map((account) => account.name).join(', ')}</strong>.
      </p>
      <OpenStep workspaceId={workspaceId} step="creneaux" target="validateurs" primary>
        Choisir qui valide
      </OpenStep>
    </>
  );
}

function GenerationStep({ onboarding }: { onboarding: Onboarding }) {
  const { workspaceId, generation, weeklyOnLaunch } = onboarding;
  if (generation === 'demandee' || generation === 'en_cours') {
    return (
      <p className={styles.waiting} role="status">
        <AutoRefresh seconds={15} />
        <strong>{generation === 'en_cours' ? 'L’IA rédige vos posts.' : 'Votre rédaction va démarrer.'}</strong> Cela prend quelques minutes. Vous pouvez quitter cette page : vous serez prévenu à la fin.
      </p>
    );
  }
  return (
    <>
      {generation === 'echec' && (
        <p className="flash error" role="alert">
          La dernière rédaction n’a pas abouti. Vous pouvez la relancer.
        </p>
      )}
      {weeklyOnLaunch && <p className="hint">Ensuite, Rostra préparera vos posts chaque semaine. Vous pourrez l’arrêter à tout moment dans Créer, onglet Rédaction.</p>}
      <form action={launchFirstRunAction.bind(null, workspaceId)}>
        <button type="submit" className="primary">
          {generation === 'echec' ? 'Relancer la rédaction' : 'Lancer ma première rédaction'}
        </button>
      </form>
    </>
  );
}

/** Une étape déjà faite : son résumé, de quoi la modifier, et la suite. */
function DoneStep({ onboarding, stepKey }: { onboarding: Onboarding; stepKey: OnboardingStepKey }) {
  const { workspaceId, steps } = onboarding;
  const step = steps.find((candidate) => candidate.key === stepKey);
  if (step === undefined) return null;
  const target = stepKey === 'comptes' ? 'comptes' : stepKey === 'ligne' ? 'ligne' : stepKey === 'creneaux' ? 'comptes' : 'redaction';
  return (
    <>
      <p className={styles.doneSummary}>
        <span aria-hidden="true">✓ </span>
        {step.detail}
      </p>
      <Link href={`/demarrage/${workspaceId}`} className="button primary">
        Continuer
      </Link>
      <details className={styles.more}>
        <summary>Modifier</summary>
        {stepKey === 'entreprise' ? (
          <CompanyStep onboarding={onboarding} />
        ) : (
          <OpenStep workspaceId={workspaceId} step={stepKey} target={target}>
            {`Ouvrir ${step.title}`}
          </OpenStep>
        )}
      </details>
    </>
  );
}

/** La prise en main : le premier post à valider, le rythme de la semaine, et où trouver quoi. */
function GettingStarted({ onboarding, firstPostId }: { onboarding: Onboarding; firstPostId: string | null }) {
  const { workspaceId, autoGeneration, canManage, closed } = onboarding;
  return (
    <section aria-labelledby="prise-en-main" className={`card ${styles.stepCard}`}>
      <p className={styles.eyebrow}>Prise en main</p>
      <h2 id="prise-en-main">Tout est prêt. Voici comment ça marche</h2>
      <ol className={styles.howto}>
        <li>
          <strong>Rostra rédige.</strong>{' '}
          {autoGeneration ? (
            'Vos posts sont préparés chaque semaine, sans rien à lancer.'
          ) : (
            <>
              La rédaction de chaque semaine n’est pas activée : <Link href={`/planning/${workspaceId}/redactions`}>l’activer dans Créer, onglet Rédaction</Link>.
            </>
          )}
        </li>
        <li>
          <strong>Vous validez.</strong> Lisez, corrigez si besoin et validez, dans l’application ou depuis l’e-mail de rappel.
        </li>
        <li>
          <strong>Rostra publie.</strong> Chaque post validé part seul sur LinkedIn, au créneau prévu.
        </li>
      </ol>
      <Link href={firstPostId === null ? '/' : `/posts/${firstPostId}`} className="button primary">
        {firstPostId === null ? 'Voir mes posts à valider' : 'Valider mon premier post'}
      </Link>
      <details className={styles.more}>
        <summary>Où trouver quoi</summary>
        <dl className={styles.menuGuide}>
          <dt>Valider</dt>
          <dd>Vos posts à relire et ceux qui vont partir.</dd>
          <dt>Créer</dt>
          <dd>Le planning, la rédaction, vos idées, les demandes et les visuels.</dd>
          <dt>Équipe</dt>
          <dd>Les membres, les comptes LinkedIn et le tableau de bord.</dd>
          <dt>Paramètres</dt>
          <dd>La ligne éditoriale, l’abonnement et ce démarrage.</dd>
          <dt>Mon compte</dt>
          <dd>Vos données, votre sécurité et vos notifications.</dd>
        </dl>
      </details>
      {canManage && !closed && (
        <form action={closeOnboardingAction.bind(null, workspaceId, true)}>
          <button type="submit" className="link">
            Terminer le démarrage
          </button>
        </form>
      )}
    </section>
  );
}

function SampleAndOptions({ onboarding, step }: { onboarding: Onboarding; step: OnboardingStepKey }) {
  const { workspaceId, company, samplePost, canManage, closed, current, brandDone } = onboarding;
  return (
    <div className={styles.extras}>
      {canManage && company.website !== null && (
        <details id="exemple" className={styles.extra} open={samplePost !== null}>
          <summary>Un exemple tout de suite</summary>
          {samplePost === null ? (
            <p className="hint">L’IA lit la page d’accueil de votre site et en tire un premier post, pour voir le résultat avant de continuer.</p>
          ) : (
            <>
              <p className="hint">{`Rédigé à partir de ${samplePost.sourceUrl}. Il n’est ni enregistré comme post ni publié ; les passages surlignés sont à compléter : l’IA n’invente ni chiffre ni référence.`}</p>
              <PostPreview accountName={company.name} accountKind="page" body={samplePost.body} media={[]} expanded />
              {samplePost.suspicious.length > 0 && <p className="hint">{`Consignes trouvées sur le site et ignorées : ${samplePost.suspicious.join(' · ')}`}</p>}
            </>
          )}
          <form action={samplePostAction.bind(null, workspaceId)}>
            <button type="submit">{samplePost === null ? 'Rédiger un post d’exemple à partir de mon site' : 'Rédiger un autre exemple'}</button>
          </form>
        </details>
      )}
      {canManage && (
        <details className={styles.extra}>
          <summary>Facultatif</summary>
          <ul className={styles.plain}>
            <li>
              <OpenStep workspaceId={workspaceId} step={step} target="charte">
                {brandDone ? 'Modifier la charte visuelle' : 'Proposer la charte à partir de votre site'}
              </OpenStep>
              <span className="hint">Couleurs, police des titres et logo de vos visuels.</span>
            </li>
            <li>
              <OpenStep workspaceId={workspaceId} step={step} target="import">
                Importer votre planning existant
              </OpenStep>
              <span className="hint">Fichier CSV ou feuille Google Sheets partagée par lien.</span>
            </li>
          </ul>
          {closed ? (
            <form action={closeOnboardingAction.bind(null, workspaceId, false)}>
              <button type="submit" className="link">
                Rouvrir le démarrage
              </button>
            </form>
          ) : (
            current !== null && (
              <form action={closeOnboardingAction.bind(null, workspaceId, true)}>
                <button type="submit" className="link">
                  Fermer le démarrage pour l’instant
                </button>
              </form>
            )
          )}
        </details>
      )}
    </div>
  );
}

/** ONB-03 : un écran par étape, dans l'ordre, repris là où on s'est arrêté, puis la prise en main. */
export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message, etape } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let onboarding: Onboarding;
  try {
    onboarding = await getOnboarding(database(), userId, workspaceId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { steps, current, canManage } = onboarding;

  // Une étape déjà faite se rouvre ; une étape à venir attend son tour.
  const asked = steps.find((step) => step.key === etape && (step.done || step.key === current));
  const active: OnboardingStepKey | 'prise-en-main' = asked?.key ?? current ?? 'prise-en-main';
  const activeIndex = steps.findIndex((step) => step.key === active);
  const activeStep = steps[activeIndex];

  let firstPostId: string | null = null;
  if (active === 'prise-en-main') {
    const posts = await listMyPosts(database(), userId, new Date());
    firstPostId = posts.find((post) => post.workspaceId === workspaceId && post.status === 'a_valider')?.id ?? null;
  }

  return (
    <div className={styles.page}>
      <h1>Démarrage · {onboarding.workspaceName}</h1>
      <Flash code={message} />
      <Stepper onboarding={onboarding} active={active} />
      {activeStep === undefined ? (
        <GettingStarted onboarding={onboarding} firstPostId={firstPostId} />
      ) : (
        <>
          <section aria-labelledby="etape-titre" className={`card ${styles.stepCard}`}>
            <p className={styles.eyebrow}>
              Étape {activeIndex + 1} sur {steps.length}
              {!activeStep.done && ` · environ ${GUIDE[activeStep.key].time}`}
            </p>
            <h2 id="etape-titre">{GUIDE[activeStep.key].heading}</h2>
            <p>{GUIDE[activeStep.key].why}</p>
            {activeStep.done ? (
              canManage ? (
                <DoneStep onboarding={onboarding} stepKey={activeStep.key} />
              ) : (
                <p className={styles.doneSummary}>{activeStep.detail}</p>
              )
            ) : !canManage ? (
              <p className="hint">Un administrateur de l’espace s’occupe de cette étape.</p>
            ) : activeStep.key === 'entreprise' ? (
              <CompanyStep onboarding={onboarding} />
            ) : activeStep.key === 'comptes' ? (
              <AccountsStep workspaceId={workspaceId} />
            ) : activeStep.key === 'ligne' ? (
              <LineStep onboarding={onboarding} />
            ) : activeStep.key === 'creneaux' ? (
              <SlotsStep onboarding={onboarding} />
            ) : (
              <GenerationStep onboarding={onboarding} />
            )}
          </section>
          <SampleAndOptions onboarding={onboarding} step={activeStep.key} />
        </>
      )}
    </div>
  );
}

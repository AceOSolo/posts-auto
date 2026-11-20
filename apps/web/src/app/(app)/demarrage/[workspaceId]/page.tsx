import { COMPANY_SIZES, NotFoundError, getOnboarding } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash } from '../../../../components/flash.tsx';
import { PostPreview } from '../../../../components/post-preview.tsx';
import { database } from '../../../../server/context.ts';
import { requireUserId } from '../../../../server/session.ts';
import { closeOnboardingAction, samplePostAction, saveCompanyAction } from '../actions.ts';

export const metadata: Metadata = { title: 'Démarrage' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZE_LABELS: Record<string, string> = { '1-9': '1 à 9 personnes', '10-49': '10 à 49 personnes', '50-249': '50 à 249 personnes', '250+': '250 personnes ou plus' };

/** ONB-03 : assistant de démarrage en six étapes, repris à tout moment. */
export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { message } = await searchParams;
  if (!UUID.test(workspaceId)) notFound();
  const userId = await requireUserId();
  let onboarding;
  try {
    onboarding = await getOnboarding(database(), userId, workspaceId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { steps, company, canManage, samplePost } = onboarding;
  const next = steps.find((s) => !s.done);

  return (
    <>
      <h1>Démarrage · {onboarding.workspaceName}</h1>
      <Flash code={message} />
      <p>
        <progress value={onboarding.doneCount} max={steps.length} aria-label={`${onboarding.doneCount} étapes sur ${steps.length}`} /> Prêt à publier à {onboarding.doneCount} sur{' '}
        {steps.length}.{' '}
        {next ? (
          <>
            Prochaine étape : <strong>{next.title}</strong>.
          </>
        ) : (
          'Tout est prêt : les posts arrivent dans « Mes posts » pour validation.'
        )}
      </p>
      <p className="hint">Vous pouvez faire les étapes dans l’ordre que vous voulez et revenir ici à tout moment : ce qui est fait ailleurs dans l’application compte aussi.</p>

      {/* Le résultat tout de suite : un post d'exemple tiré du site, avant même de connecter LinkedIn. */}
      <section aria-labelledby="exemple-titre" id="exemple" className="card">
        <h2 id="exemple-titre">Un exemple tout de suite</h2>
        {samplePost === null ? (
          <p className="hint">
            {company.website === null
              ? 'Indiquez le site de l’entreprise à l’étape 1 : l’IA en tire un premier post, pour voir le résultat avant même de connecter LinkedIn.'
              : 'L’IA lit la page d’accueil de votre site et en tire un premier post, pour voir le résultat avant même de connecter LinkedIn.'}
          </p>
        ) : (
          <>
            <p className="hint">
              {`Rédigé à partir de ${samplePost.sourceUrl}. Il n’est ni enregistré comme post ni publié ; les passages surlignés sont à compléter : l’IA n’invente ni chiffre ni référence.`}
            </p>
            <PostPreview accountName={company.name} accountKind="page" body={samplePost.body} media={[]} expanded />
            {samplePost.suspicious.length > 0 && <p className="hint">{`Consignes trouvées sur le site et ignorées : ${samplePost.suspicious.join(' · ')}`}</p>}
            <p className="hint">Avec votre ligne éditoriale, vos créneaux et vos comptes, les posts sont rédigés chaque semaine de la même façon, puis validés en un geste.</p>
          </>
        )}
        {canManage && company.website !== null && (
          <form action={samplePostAction.bind(null, workspaceId)}>
            <button type="submit" className={samplePost === null ? 'primary' : undefined}>
              {samplePost === null ? 'Rédiger un post d’exemple à partir de mon site' : 'Rédiger un autre exemple'}
            </button>
          </form>
        )}
      </section>

      <ol className="onboarding-steps">
        {steps.map((step, index) => (
          <li key={step.key} className={step.done ? 'done' : undefined} id={`etape-${step.key}`}>
            <h2>
              <span aria-hidden="true">{step.done ? '✔' : index + 1}</span> {step.title}
              {step.done && <span className="visually-hidden"> (fait)</span>}
            </h2>
            <p className="hint">{step.detail}</p>
            {step.key === 'entreprise' && canManage ? (
              <details open={!step.done}>
                <summary>{step.done ? 'Modifier' : 'Renseigner'}</summary>
                <form action={saveCompanyAction.bind(null, workspaceId)} className="stack">
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
                  <button type="submit" className="primary">
                    Enregistrer
                  </button>
                </form>
              </details>
            ) : (
              step.href && <Link href={step.href}>{step.done ? 'Voir ou modifier' : 'Faire cette étape'}</Link>
            )}
          </li>
        ))}
      </ol>

      {/* ONB-05, ONB-09 : aides facultatives du démarrage. */}
      <section aria-labelledby="facultatif" className="card">
        <h2 id="facultatif">Pour aller plus vite (facultatif)</h2>
        <ul>
          <li>
            <Link href={`/planning/${workspaceId}/import?depuis=demarrage`}>Importer votre planning existant</Link> : fichier CSV ou feuille Google Sheets partagée par lien ; les sujets
            sont placés sur la grille, à revoir avant la rédaction.
          </li>
          <li>
            <Link href={`/visuels/${workspaceId}#proposer-charte`}>Proposer la charte à partir de votre site</Link> : couleurs, police des titres et logo, à relire avant d’enregistrer.
          </li>
        </ul>
      </section>

      {canManage &&
        (onboarding.closed ? (
          <form action={closeOnboardingAction.bind(null, workspaceId, false)}>
            <button type="submit">Rouvrir l’assistant (indicateur sur « Mes posts »)</button>
          </form>
        ) : (
          <form action={closeOnboardingAction.bind(null, workspaceId, true)}>
            <button type="submit">{next ? 'Fermer l’assistant pour l’instant' : 'Terminer le démarrage'}</button>
          </form>
        ))}
    </>
  );
}

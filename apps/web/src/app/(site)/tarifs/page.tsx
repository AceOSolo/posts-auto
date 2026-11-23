import { publicPlans, simulatePrice } from '@posts-auto/services';
import Link from 'next/link';
import { appUrl, database } from '../../../server/context.ts';
import { FaqList, type FaqItem, FinalCta, JsonLd, PageIntro, PlanCards, PriceSimulator, breadcrumbSchema, countParam, faqSchema, pageMetadata } from '../vitrine.tsx';

export const dynamic = 'force-dynamic';

export const metadata = pageMetadata(
  'Tarifs Rostra · Prix de l’outil de posts LinkedIn par IA',
  'Les formules Rostra : un prix par compte LinkedIn actif, des posts rédigés par l’IA inclus, un simulateur de prix et 14 jours d’essai sans carte bancaire.',
  '/tarifs',
);

const FAQ: readonly FaqItem[] = [
  { q: 'Qu’est-ce qu’un compte actif ?', a: 'Un profil ou une page LinkedIn connecté à Rostra. Un compte mis en pause ou déconnecté n’est pas facturé à la période suivante.' },
  { q: 'Que se passe-t-il si j’ajoute un compte en cours de mois ?', a: 'Il est facturé au prorata. À l’inverse, un retrait prend effet à la période suivante.' },
  { q: 'Les posts inclus sont-ils par compte ?', a: 'Le quota se calcule par compte, puis il est mis en commun dans l’espace : un compte peut publier plus, un autre moins.' },
  { q: 'Et si j’atteins mon quota ?', a: 'Vous êtes prévenu à 80 % puis à 100 %. Vous choisissez ensuite : la rédaction attend le mois suivant, ou vous achetez un pack de posts supplémentaires.' },
  { q: 'Une correction ou une nouvelle version consomme-t-elle un post ?', a: 'Non. Seules les premières rédactions comptent dans le quota de posts.' },
  { q: 'Puis-je résilier ?', a: 'Oui, depuis le portail de facturation. L’abonnement prend fin à l’échéance de la période en cours.' },
];

export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const plans = await publicPlans(database());
  const profiles = countParam(query['profils'], 3);
  const pages = countParam(query['pages'], 1);
  const simulation = simulatePrice(plans, profiles, pages);
  const has = (feature: string) => plans.map((p) => p.features.includes(feature));
  const rows: readonly (readonly [string, readonly boolean[]])[] = [
    ['Planning, validation, publication', plans.map(() => true)],
    ['Visuels à votre charte', plans.map(() => true)],
    ['Slack et Microsoft Teams', plans.map(() => true)],
    ['Modèles Canva', has('canva')],
    ['Sources externes et veille', has('sources')],
    ['Statistiques LinkedIn', has('statistiques')],
    ['Espaces clients illimités', has('espaces_illimites')],
    ['Rapport mensuel par client', has('rapports')],
  ];

  return (
    <main className="site-main vitrine">
      <JsonLd data={[breadcrumbSchema(appUrl(), 'Tarifs', '/tarifs'), faqSchema(FAQ)]} />
      <PageIntro crumb="Tarifs" title="Un prix par compte LinkedIn, sans surprise" lead="Vous payez pour les profils et les pages réellement connectés. Les posts rédigés par l’IA sont inclus, et mis en commun entre vos comptes." />

      <section className="bloc teinte" aria-labelledby="formules">
        <div className="wrap">
          <h2 id="formules">Les formules</h2>
          <p className="chapo">Prix hors taxes. Paiement mensuel ou annuel, par carte ou prélèvement SEPA.</p>
          <PlanCards plans={plans} />
          <PriceSimulator simulation={simulation} profiles={profiles} pages={pages} action="/tarifs#simulateur" />
        </div>
      </section>

      <section className="bloc blanc" aria-labelledby="comparer">
        <div className="wrap">
          <h2 id="comparer">Comparer les formules</h2>
          <div className="table-scroll comparatif" tabIndex={0} role="region" aria-label="Comparatif des formules, défilable horizontalement">
            <table>
              <thead>
                <tr>
                  <th scope="col">Inclus</th>
                  {plans.map((p) => (
                    <th scope="col" key={p.key}>
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Posts rédigés par compte et par mois</th>
                  {plans.map((p) => (
                    <td key={p.key}>{p.postsPerAccount}</td>
                  ))}
                </tr>
                {rows.map(([label, values]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {values.map((v, i) => (
                      <td key={plans[i]?.key}>{v ? 'Oui' : '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            Besoin d’un volume particulier ? <Link href="/#demo">Parlons-en</Link>.
          </p>
        </div>
      </section>

      <section className="bloc" aria-labelledby="faq-tarifs">
        <div className="wrap">
          <h2 id="faq-tarifs">Questions sur les tarifs</h2>
          <FaqList items={FAQ} />
        </div>
      </section>
      <FinalCta title="Essayez avant de choisir." text="14 jours, 3 comptes LinkedIn et 10 posts rédigés, sans carte bancaire." />
    </main>
  );
}

/**
 * Briques communes aux pages du site vitrine (SIT-01, SIT-03, SIT-06) : rendu serveur, sans
 * JavaScript. Les prix viennent toujours des formules en base : une formule sans prix
 * s'affiche « Sur demande », aucun montant n'est écrit ici.
 */
import type { publicPlans, simulatePrice } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { type ReactNode, useId } from 'react';
import { Tesselles } from './scenes.tsx';

type Plans = Awaited<ReturnType<typeof publicPlans>>;
type Simulation = ReturnType<typeof simulatePrice>;
export interface FaqItem {
  readonly q: string;
  readonly a: string;
}

export const euros = (cents: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);

export const countParam = (value: string | string[] | undefined, fallback: number) => {
  const n = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 500 ? n : fallback;
};

/** Image de partage : à répéter sur chaque page qui définit son propre `openGraph`, sinon elle est perdue. */
export const OG_IMAGE = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'Rostra : toute l’équipe prend la parole. Vos posts LinkedIn rédigés par l’IA, validés par chacun, publiés à l’heure.',
};

/** Métadonnées d'une page publique indexable (SIT-06). */
export function pageMetadata(title: string, description: string, path: string): Metadata {
  return {
    title: { absolute: title },
    description,
    robots: { index: true, follow: true },
    alternates: { canonical: path },
    openGraph: { title, description, type: 'website', locale: 'fr_FR', siteName: 'Rostra', url: path, images: [OG_IMAGE] },
  };
}

export const faqSchema = (items: readonly FaqItem[]) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
});

export const breadcrumbSchema = (base: string, name: string, path: string) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Accueil', item: `${base}/` },
    { '@type': 'ListItem', position: 2, name, item: `${base}${path}` },
  ],
});

export function JsonLd({ data }: { data: unknown }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: données structurées produites ici, sans contenu saisi.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />;
}

/** Frise de tesselles, la matière de la marque : posées légèrement de travers, toujours au même endroit. */
export function Frise() {
  const id = `frise-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const tiles = Array.from({ length: 90 }, (_, i) => ({
    x: i * 20 + 1,
    rotate: (((i * 37) % 7) - 3) * 1.6,
    tone: ['rose', 'nuit', 'soleil', 'rose', 'vert', 'nuit', 'rose', 'marbre'][(i * i + 3 * i) % 8],
  }));
  // Motif à taille réelle, répété : les tesselles restent entières quelle que soit la largeur de l'écran.
  return (
    <div className="frise" aria-hidden="true">
      <svg height="22" focusable="false">
        <defs>
          <pattern id={id} patternUnits="userSpaceOnUse" width={1800} height={22}>
            {tiles.map((t) => (
              <rect key={t.x} className={`t-${t.tone}`} x={t.x} y={3} width={17} height={16} rx={2.5} transform={`rotate(${t.rotate} ${t.x + 8.5} 11)`} />
            ))}
          </pattern>
        </defs>
        <rect width="100%" height="22" fill={`url(#${id})`} />
      </svg>
    </div>
  );
}

export function PageIntro({ crumb, title, lead, children }: { crumb: string; title: string; lead: string; children?: ReactNode }) {
  return (
    <header className="intro">
      <div className="wrap">
        <nav aria-label="Fil d’Ariane" className="crumbs">
          <Link href="/">Accueil</Link> <span aria-hidden="true">›</span> <span aria-current="page">{crumb}</span>
        </nav>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
        {children ?? <TrialActions />}
      </div>
      <Frise />
    </header>
  );
}

export function TrialActions() {
  return (
    <>
      <div className="actions">
        <Link href="/inscription" className="button primary">
          Essai gratuit 14 jours
        </Link>
        <Link href="/#demo" className="button">
          Demander une démo
        </Link>
      </div>
      <p className="hint">Sans carte bancaire. 3 comptes LinkedIn et 10 posts pendant l’essai.</p>
    </>
  );
}

const PLAN_FEATURES: readonly (readonly [string, string])[] = [
  ['canva', 'Modèles Canva'],
  ['sources', 'Sources externes et veille'],
  ['statistiques', 'Statistiques LinkedIn'],
  ['espaces_illimites', 'Espaces clients illimités'],
  ['rapports', 'Rapport mensuel par client'],
];

export function PlanCards({ plans }: { plans: Plans }) {
  return (
    <ul className="plans">
      {plans.map((p) => (
        <li key={p.key}>
          <h3>{p.name}</h3>
          <p className="price">
            {p.priceMonthlyCents === null ? (
              'Sur demande'
            ) : (
              <>
                {euros(p.priceMonthlyCents)} <small>HT / compte / mois</small>
              </>
            )}
          </p>
          {p.priceYearlyCents !== null && <p className="hint">ou {euros(p.priceYearlyCents)} HT par compte et par an</p>}
          <ul>
            <li>
              <strong>{p.postsPerAccount} posts rédigés</strong> par compte et par mois
            </li>
            <li>Planning, validation et publication</li>
            <li>Visuels à votre charte</li>
            {PLAN_FEATURES.filter(([key]) => p.features.includes(key)).map(([key, label]) => (
              <li key={key}>{label}</li>
            ))}
          </ul>
          {p.priceMonthlyCents === null ? (
            <Link href="/#demo" className="button">
              Nous contacter
            </Link>
          ) : (
            <Link href="/inscription" className="button primary">
              Essayer {p.name}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PriceSimulator({ simulation, profiles, pages, action }: { simulation: Simulation; profiles: number; pages: number; action: string }) {
  const accounts = simulation[0]?.accounts ?? 1;
  return (
    <div className="simulator">
      <h3 id="simulateur">Simulateur</h3>
      <form method="get" action={action} className="inline-fields">
        <label>
          Profils LinkedIn
          <input name="profils" type="number" min={0} max={500} defaultValue={profiles} />
        </label>
        <label>
          Pages d’entreprise
          <input name="pages" type="number" min={0} max={500} defaultValue={pages} />
        </label>
        <button type="submit">Calculer</button>
      </form>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Résultat du simulateur, défilable horizontalement">
        <table>
          <thead>
            <tr>
              <th scope="col">Formule</th>
              <th scope="col">Prix mensuel HT</th>
              <th scope="col">En annuel (par mois)</th>
              <th scope="col">Posts rédigés par mois</th>
            </tr>
          </thead>
          <tbody>
            {simulation.map((s) => (
              <tr key={s.plan.key}>
                <th scope="row">{s.plan.name}</th>
                <td>{s.monthlyCents === null ? 'sur demande' : euros(s.monthlyCents)}</td>
                <td>{s.yearlyMonthlyCents === null ? '—' : euros(s.yearlyMonthlyCents)}</td>
                <td>{s.postsPerMonth}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Pour {accounts} compte{accounts > 1 ? 's' : ''}. Les posts sont mis en commun entre les comptes de l’espace ; au-delà, des packs supplémentaires sont proposés, ou la rédaction attend le
        mois suivant, à votre choix.
      </p>
    </div>
  );
}

export function FaqList({ items }: { items: readonly FaqItem[] }) {
  return (
    <div className="faq-list">
      {items.map((f) => (
        <details key={f.q}>
          <summary>{f.q}</summary>
          <p>{f.a}</p>
        </details>
      ))}
    </div>
  );
}

export function FinalCta({ title, text }: { title: string; text: string }) {
  return (
    <section className="bloc final" aria-labelledby="final-titre">
      <Tesselles nombre={18} />
      <div className="wrap">
        <h2 id="final-titre">{title}</h2>
        <p>{text}</p>
        <TrialActions />
      </div>
    </section>
  );
}

import { publicPlans, simulatePrice, siteTestimonial } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Flash } from '../../../components/flash.tsx';
import { appUrl, database } from '../../../server/context.ts';
import { requestDemoAction } from './actions.ts';

export const dynamic = 'force-dynamic';

const TITLE = 'Posts LinkedIn rédigés par IA, validés par vous, publiés à l’heure';
const DESCRIPTION =
  'Planning éditorial, rédaction des posts LinkedIn par l’IA dans votre ton, validation en un clic par chaque titulaire, publication automatique. Pour les PME, ETI et agences.';

export const metadata: Metadata = {
  title: { absolute: `Rostra · ${TITLE}` },
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', locale: 'fr_FR', siteName: 'Rostra' },
};

const FAQ: readonly { q: string; a: string }[] = [
  {
    q: 'Les posts partent-ils sans mon accord ?',
    a: 'Non. Chaque post est proposé au titulaire du compte, qui le valide, le corrige ou le refuse. Sans validation, rien ne part : le post est décalé ou repris.',
  },
  {
    q: 'L’IA peut-elle inventer des chiffres ou des références ?',
    a: 'Elle a pour consigne de ne rien inventer : quand une information manque, elle laisse un marqueur [À COMPLÉTER] qui bloque la publication tant qu’il n’est pas traité. Une seconde relecture automatique vérifie le texte avant qu’il vous soit proposé.',
  },
  {
    q: 'Faut-il donner mon mot de passe LinkedIn ?',
    a: 'Non. Chaque titulaire connecte son profil, ou les pages qu’il administre, par l’autorisation officielle de LinkedIn. Il peut la retirer à tout moment.',
  },
  {
    q: 'Peut-on gérer plusieurs clients ?',
    a: 'Oui : la formule Agence donne un espace par client, avec sa ligne éditoriale, ses comptes, son planning et son équipe, et un export de l’usage pour la refacturation.',
  },
  {
    q: 'Comment est calculé le prix ?',
    a: 'Par compte LinkedIn actif (profil ou page), avec un nombre de posts rédigés par mois et par compte, mis en commun dans l’espace. Paiement mensuel ou annuel, sans engagement en mensuel.',
  },
  {
    q: 'Où sont mes données ?',
    a: 'Dans l’Union européenne. Les sous-traitants sont listés sur une page dédiée, et chacun peut télécharger toutes les données qui le concernent.',
  },
];

const FEATURES: readonly { title: string; text: string }[] = [
  { title: 'Planning éditorial', text: 'Une grille comptes × semaines, vos événements et vos sujets, importable depuis un tableur ou une feuille Google Sheets.' },
  { title: 'Rédaction dans votre ton', text: 'Ligne éditoriale, voix de chaque compte, exemples à imiter et à éviter : l’IA apprend des corrections de chacun.' },
  { title: 'Validation en un clic', text: 'Sur téléphone, depuis l’e-mail de rappel : valider, corriger ou refuser avec un motif. Rappels avant chaque créneau.' },
  { title: 'Visuels aux couleurs de la marque', text: 'Modèles à votre charte, vos photos ou des images générées signalées comme telles, avec un budget mensuel.' },
  { title: 'Publication automatique', text: 'Au créneau prévu, sur les profils et les pages, sans doublon ; ou par e-mail pour les comptes en publication manuelle.' },
  { title: 'Suivi et rapports', text: 'Tableau de bord, statistiques LinkedIn, enseignements du mois et rapport PDF mensuel, utile aux agences.' },
];

const euros = (cents: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
const int = (value: string | string[] | undefined, fallback: number) => {
  const n = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 500 ? n : fallback;
};

/** SIT-01 à SIT-03, SIT-06, SIT-08 : page unique du site vitrine. */
export default async function LandingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const plans = await publicPlans(database());
  const testimonial = await siteTestimonial(database());
  const profiles = int(query['profils'], 3);
  const pages = int(query['pages'], 1);
  const simulation = simulatePrice(plans, profiles, pages);
  const base = appUrl();
  // SIT-06 : données structurées.
  const jsonLd = [
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'SimplX', url: base },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Rostra',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description: DESCRIPTION,
      url: base,
      ...(plans.some((p) => p.priceMonthlyCents !== null) && {
        offers: plans
          .filter((p) => p.priceMonthlyCents !== null)
          .map((p) => ({ '@type': 'Offer', name: p.name, price: ((p.priceMonthlyCents as number) / 100).toFixed(2), priceCurrency: 'EUR', description: 'Par compte LinkedIn et par mois, hors taxes' })),
      }),
    },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
  ];

  return (
    <main className="site-main">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: données structurées produites ici, sans contenu saisi. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <div className="hero">
        <div>
        <p className="eyebrow">Posts LinkedIn · PME, ETI et agences</p>
        <h1>
          Vos posts LinkedIn rédigés par l’IA, <em>validés par vous</em>, publiés à l’heure.
        </h1>
        <p className="lead">
          Chaque semaine, l’IA rédige les posts de vos dirigeants, de vos experts et de vos pages d’entreprise, dans le ton de chacun. Chaque titulaire valide en quelques secondes sur son
          téléphone ; la publication est automatique.
        </p>
        <div className="actions">
          <Link href="/inscription" className="button primary">
            Essai gratuit 14 jours
          </Link>
          <a href="#demo" className="button">
            Demander une démo
          </a>
        </div>
        <p className="hint">Sans carte bancaire. 3 comptes LinkedIn et 10 posts pendant l’essai.</p>
        </div>
        {/* Illustration : un post proposé à son titulaire. Décorative, ignorée des lecteurs d'écran. */}
        <div className="hero-card" aria-hidden="true">
          <header>
            <span className="li-avatar">CM</span>
            <span className="who">
              Claire M.
              <small>Directrice générale · mardi 8 h 30</small>
            </span>
            <span className="badge status-a_valider">À valider</span>
          </header>
          <div className="lines">
            <span />
            <span />
            <span />
          </div>
          <div className="card-actions">
            <span className="ok">Valider</span>
            <span>Corriger</span>
          </div>
        </div>
      </div>

      <section id="fonctionnement" aria-labelledby="fonctionnement-titre">
        <h2 id="fonctionnement-titre">Comment ça marche</h2>
        <ol className="steps-list">
          <li>
            <h3>Planning</h3>
            <p>Vous posez vos temps forts, vos événements et vos sujets ; l’IA complète avec des idées et votre veille.</p>
          </li>
          <li>
            <h3>Rédaction par l’IA</h3>
            <p>Les posts des deux semaines à venir sont rédigés dans le ton de chaque compte, avec leur visuel.</p>
          </li>
          <li>
            <h3>Validation</h3>
            <p>Chaque titulaire valide, corrige ou refuse ; rien ne part sans son accord.</p>
          </li>
          <li>
            <h3>Publication</h3>
            <p>Au créneau prévu, sur LinkedIn ; vous suivez les statistiques et les enseignements du mois.</p>
          </li>
        </ol>
      </section>

      <section aria-labelledby="fonctionnalites">
        <h2 id="fonctionnalites">Fonctionnalités</h2>
        <ul className="feature-grid">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pour-qui">
        <h2 id="pour-qui">Pour qui</h2>
        <ul className="feature-grid">
          <li>
            <h3>PME et ETI</h3>
            <p>Faire parler vos dirigeants et vos experts sur LinkedIn, régulièrement, sans y passer vos soirées : la communication pilote, chacun valide ses posts.</p>
          </li>
          <li>
            <h3>Agences</h3>
            <p>Un espace par client, des validations sans aller-retour par e-mail, un rapport mensuel par client et l’usage exporté pour la refacturation.</p>
          </li>
        </ul>
      </section>

      {testimonial !== null && (
        <section aria-labelledby="temoignage">
          <h2 id="temoignage">Ils l’utilisent</h2>
          <figure>
            <blockquote className="testimonial">
              <p>« {testimonial.quote} »</p>
            </blockquote>
            <figcaption>
              {testimonial.author}
              {testimonial.role && `, ${testimonial.role}`}
              {testimonial.company && ` · ${testimonial.company}`}
            </figcaption>
          </figure>
        </section>
      )}

      <section id="tarifs" aria-labelledby="tarifs-titre">
        <h2 id="tarifs-titre">Tarifs</h2>
        <p className="hint">Prix hors taxes, par compte LinkedIn actif (profil ou page). Paiement mensuel ou annuel, par carte ou prélèvement SEPA.</p>
        <ul className="plan-grid">
          {plans.map((p) => (
            <li key={p.key}>
              <h3>{p.name}</h3>
              <p className="price">{p.priceMonthlyCents === null ? 'Sur demande' : `${euros(p.priceMonthlyCents)} / compte / mois`}</p>
              {p.priceYearlyCents !== null && <p className="hint">ou {euros(p.priceYearlyCents)} par compte et par an</p>}
              <ul>
                <li>{p.postsPerAccount} posts rédigés par compte et par mois</li>
                <li>{p.maxWorkspaces === null ? 'Espaces clients illimités' : 'Un espace'}</li>
                {p.features.includes('statistiques') && <li>Statistiques LinkedIn</li>}
                {p.features.includes('rapports') && <li>Rapport mensuel par client</li>}
              </ul>
            </li>
          ))}
        </ul>

        <h3 id="simulateur">Simulateur</h3>
        <form method="get" action="/#simulateur" className="inline-fields">
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
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Tableau, défilable horizontalement">
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
          Pour {simulation[0]?.accounts ?? 1} compte{(simulation[0]?.accounts ?? 1) > 1 ? 's' : ''}. Les posts sont mis en commun entre les comptes de l’espace ; au-delà, des packs
          supplémentaires sont proposés, ou la rédaction attend le mois suivant, à votre choix.
        </p>
      </section>

      <section id="faq" aria-labelledby="faq-titre">
        <h2 id="faq-titre">Questions fréquentes</h2>
        <dl className="faq">
          {FAQ.map((f) => (
            <div key={f.q}>
              <dt>{f.q}</dt>
              <dd>{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="demo" aria-labelledby="demo-titre">
        <h2 id="demo-titre">Demander une démonstration</h2>
        <Flash code={query['message']} />
        <form action={requestDemoAction} className="stack">
          <label>
            Nom
            <input name="nom" required maxLength={120} autoComplete="name" />
          </label>
          <label>
            Entreprise
            <input name="entreprise" required maxLength={160} autoComplete="organization" />
          </label>
          <label>
            E-mail professionnel
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Téléphone
            <input name="telephone" type="tel" maxLength={40} autoComplete="tel" />
          </label>
          <label>
            Nombre de comptes LinkedIn
            <input name="comptes" type="number" min={1} max={10000} />
          </label>
          <label>
            Message (facultatif)
            <textarea name="message" rows={3} maxLength={2000} />
          </label>
          {/* Champ piège pour les robots : invisible et ignoré par les lecteurs d'écran. */}
          <label className="visually-hidden-field" aria-hidden="true">
            Site web
            <input name="site" tabIndex={-1} autoComplete="off" />
          </label>
          <p className="hint">
            Vos coordonnées servent uniquement à vous recontacter au sujet de cette démonstration (<Link href="/confidentialite">confidentialité</Link>).
          </p>
          <button type="submit" className="primary">
            Envoyer la demande
          </button>
        </form>
      </section>
    </main>
  );
}

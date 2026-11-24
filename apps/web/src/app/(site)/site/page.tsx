import { publicPlans, simulatePrice, siteTestimonial } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Flash } from '../../../components/flash.tsx';
import { appUrl, database } from '../../../server/context.ts';
import { AvantApres, MiniVisuel, PlanningVivant, Tesselles } from '../scenes.tsx';
import { FaqList, type FaqItem, FinalCta, Frise, JsonLd, OG_IMAGE, PlanCards, PriceSimulator, countParam, faqSchema } from '../vitrine.tsx';
import { EssaiValidation, Parcours, PostVivant } from '../vivant.tsx';
import { requestDemoAction } from './actions.ts';

export const dynamic = 'force-dynamic';

const TITLE = 'Rostra · Posts LinkedIn par IA, validés par vous';
const DESCRIPTION =
  'Rostra rédige les posts LinkedIn de vos dirigeants, experts et pages dans le ton de chacun. Validation en un clic, publication automatique. Essai 14 jours.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  alternates: { canonical: '/', languages: { fr: '/', en: '/en' } },
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', locale: 'fr_FR', siteName: 'Rostra', url: '/', images: [OG_IMAGE] },
};

const PREUVES: readonly (readonly [string, string])[] = [
  ['Rien ne part sans validation', 'Le titulaire du compte garde le dernier mot'],
  ['Aucun mot de passe LinkedIn', 'Connexion par l’autorisation officielle'],
  ['Aucun fait inventé', 'Une information manque ? La publication est bloquée'],
  ['Hébergé dans l’Union européenne', 'Export de vos données à tout moment'],
];

const POINTS: readonly (readonly [string, string])[] = [
  ['Le dirigeant n’a plus à trouver le temps', 'Son post l’attend sur son téléphone, déjà écrit dans son ton.'],
  ['La com’ ne court plus après personne', 'Une vue par semaine, et des rappels automatiques avant chaque créneau.'],
  ['L’IA ne parle pas à votre place', 'Ce qu’elle ne sait pas, elle le signale au lieu de l’inventer.'],
];

const SEMAINE: readonly (readonly [string, string, string])[] = [
  ['Lundi matin', 'Le récapitulatif.', 'Chaque titulaire reçoit la liste de ses posts à valider pour les jours à venir.'],
  ['24 h avant', 'Premier rappel.', 'Si le post n’est pas validé, un e-mail permet de le relire et de le valider sans se connecter.'],
  ['3 h avant', 'Dernier rappel.', 'Le titulaire est prévenu une dernière fois, et la com’ voit dans sa vue d’équipe qui n’a pas répondu.'],
  ['À l’heure dite', 'Publication.', 'Le post validé part sur LinkedIn. Sans validation, il ne part pas : il est décalé ou repris.'],
  ['7 jours après', 'Le bilan.', 'Les statistiques remontent et nourrissent les enseignements du mois.'],
];

const FEATURES: readonly { title: string; text: string; visuel: string }[] = [
  { visuel: 'planning', title: 'Planning éditorial', text: 'Par compte et par semaine, importable depuis un tableur.' },
  { visuel: 'voix', title: 'Voix de chaque compte', text: 'L’IA apprend des corrections de chacun.' },
  { visuel: 'idees', title: 'Boîte à idées', text: 'Chacun propose ses sujets, même à la voix.' },
  { visuel: 'visuels', title: 'Visuels à votre charte', text: 'Vos modèles, vos photos, ou des images signalées comme générées.' },
  { visuel: 'validation', title: 'Validation sur téléphone', text: 'Valider, corriger ou refuser, avec l’aperçu LinkedIn.' },
  { visuel: 'delegation', title: 'Délégation', text: 'Quelqu’un valide à votre place, et tout reste tracé.' },
  { visuel: 'publication', title: 'Publication automatique', text: 'Profils et pages, au créneau prévu, sans doublon.' },
  { visuel: 'canaux', title: 'Slack et Microsoft Teams', text: 'Les posts à valider arrivent dans le canal de l’équipe.' },
  { visuel: 'stats', title: 'Statistiques et rapports', text: 'Meilleurs moments, enseignements et rapport PDF mensuel.' },
];

const FAQ: readonly FaqItem[] = [
  {
    q: 'Les posts partent-ils sans mon accord ?',
    a: 'Non. Chaque post est proposé au titulaire du compte, ou à la personne qu’il a désignée, qui le valide, le corrige ou le refuse. Sans validation, rien ne part : le post est décalé ou repris.',
  },
  {
    q: 'L’IA peut-elle inventer des chiffres ou des références ?',
    a: 'Elle a pour consigne de ne rien inventer : quand une information manque, elle laisse un marqueur [À COMPLÉTER] qui bloque la publication tant qu’il n’est pas traité. Une seconde relecture automatique compare le texte à vos sources avant qu’il vous soit proposé. L’IA peut malgré tout se tromper : c’est pour cela qu’une personne valide toujours.',
  },
  {
    q: 'Est-ce que mes posts vont ressembler à ceux de tout le monde ?',
    a: 'Chaque compte a sa fiche : voix, ton, sujets à éviter, exemples de posts à imiter ou à éviter. Vos corrections sont retenues pour les rédactions suivantes, et vous pouvez lire et modifier ce qui a été appris.',
  },
  {
    q: 'Faut-il donner mon mot de passe LinkedIn ?',
    a: 'Non. Chaque titulaire connecte son profil, ou les pages qu’il administre, par l’autorisation officielle de LinkedIn. Il peut la retirer à tout moment.',
  },
  {
    q: 'Combien de temps faut-il pour démarrer ?',
    a: 'Vous créez votre compte, renseignez votre site et votre ligne éditoriale, puis Rostra rédige un premier post d’exemple à partir de votre site, avant même de connecter LinkedIn.',
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
    q: 'Que se passe-t-il à la fin de l’essai ?',
    a: 'L’essai dure 14 jours, sans carte bancaire. À son terme, la rédaction s’arrête tant que vous n’avez pas choisi de formule ; les posts déjà validés partent quand même.',
  },
  {
    q: 'Où sont mes données ?',
    a: 'Le service et ses données sont hébergés dans l’Union européenne. La rédaction est confiée à Claude (Anthropic, États-Unis) sous clauses contractuelles types, sans entraînement sur vos textes. Tous les sous-traitants sont listés sur une page dédiée, et chacun peut télécharger les données qui le concernent.',
  },
];

/** SIT-01 à SIT-03, SIT-06, SIT-08 : page d'accueil du site vitrine. */
export default async function LandingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const plans = await publicPlans(database());
  const testimonial = await siteTestimonial(database());
  const profiles = countParam(query['profils'], 3);
  const pages = countParam(query['pages'], 1);
  const simulation = simulatePrice(plans, profiles, pages);
  const base = appUrl();
  const priced = plans.filter((p) => p.priceMonthlyCents !== null);
  // SIT-06 : données structurées.
  const jsonLd = [
    { '@context': 'https://schema.org', '@type': 'Organization', name: 'SimplX', url: base, brand: { '@type': 'Brand', name: 'Rostra', slogan: 'Prenez la parole.' } },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Rostra', url: base, inLanguage: 'fr-FR' },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Rostra',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description: DESCRIPTION,
      url: base,
      ...(priced.length > 0 && {
        offers: priced.map((p) => ({ '@type': 'Offer', name: p.name, price: ((p.priceMonthlyCents as number) / 100).toFixed(2), priceCurrency: 'EUR', description: 'Par compte LinkedIn et par mois, hors taxes' })),
      }),
    },
    faqSchema(FAQ),
  ];

  return (
    <main className="site-main vitrine">
      <JsonLd data={jsonLd} />

      <div className="wrap">
        <div className="hero">
          <div>
            <h1>
              Toute l’équipe prend la{' '}
              <span className="said">
                parole
                <svg viewBox="0 0 300 24" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M4 16C60 6 120 20 170 11S260 6 296 14" pathLength={1} strokeWidth="9" fill="none" strokeLinecap="round" />
                </svg>
              </span>{' '}
              sur LinkedIn.
            </h1>
            <p className="lead">
              Rostra rédige chaque semaine les posts LinkedIn de vos dirigeants, de vos experts et de vos pages d’entreprise, dans le ton de chacun. Ils valident en quelques secondes sur leur
              téléphone, la publication suit toute seule.
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
          {/* Illustration : le buste en mosaïque prend la parole ; une même actualité s'écrit dans trois voix, puis part. Décorative. */}
          <div className="hero-art" aria-hidden="true">
            <Tesselles nombre={12} />
            <img src="/marque/buste-mosaique.svg" alt="" width={520} height={520} fetchPriority="high" />
            <PostVivant />
          </div>
        </div>
        <ul className="preuves" aria-label="Nos engagements">
          {PREUVES.map(([titre, detail]) => (
            <li key={titre}>
              <span className="tessere" aria-hidden="true" />
              <span>
                {titre}
                <small>{detail}</small>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <Frise />

      <section className="bloc" aria-labelledby="interet">
        <div className="wrap">
          <h2 id="interet">Être présent sur LinkedIn, sans que ça repose sur une seule personne</h2>
          <AvantApres />
          <ul className="points">
            {POINTS.map(([titre, texte]) => (
              <li key={titre}>
                <span className="tessere" aria-hidden="true" />
                <div>
                  <h3>{titre}</h3>
                  <p>{texte}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="fonctionnement" className="bloc blanc" aria-labelledby="fonctionnement-titre">
        <div className="wrap">
          <h2 id="fonctionnement-titre">Comment ça marche</h2>
          <Parcours />
          <h3 className="visually-hidden">Le déroulé d’un post</h3>
          <ol className="semaine">
            {SEMAINE.map(([quand, titre, texte]) => (
              <li key={quand}>
                <span className="quand">{quand}</span>
                <p>
                  <strong>{titre}</strong> {texte}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="bloc" aria-labelledby="produit">
        <div className="wrap">
          <h2 id="produit">Pensé pour ceux qui valident et pour ceux qui pilotent</h2>
          <div className="ecrans">
            <div className="ecran">
              <div>
                <h3>Pour le titulaire : tout se passe sur son téléphone</h3>
                <p>Le post arrive avec son aperçu LinkedIn et l’heure de départ. Une information manque ? Elle est surlignée, et le post ne peut pas partir tant qu’elle n’est pas complétée.</p>
                <ul className="coches">
                  <li>Valider depuis l’e-mail de rappel, sans se connecter</li>
                  <li>Corriger le texte, ou demander une nouvelle version</li>
                  <li>Refuser avec un motif : l’IA propose un autre sujet</li>
                </ul>
              </div>
              <EssaiValidation />
            </div>
            <div className="ecran">
              <div>
                <h3>Pour la com’ : toute la semaine d’un coup d’œil</h3>
                <p>Le planning montre chaque compte et chaque post, avec son état. Vous savez qui doit encore répondre, sans ouvrir un tableur.</p>
                <ul className="coches">
                  <li>Grille par compte et par semaine, exportable</li>
                  <li>Filtre « en attente » pour voir qui doit répondre</li>
                  <li>Historique complet de chaque post</li>
                </ul>
              </div>
              <PlanningVivant />
            </div>
          </div>
        </div>
      </section>

      <section className="bloc nuit" aria-labelledby="garde-fous">
        <Tesselles nombre={22} />
        <div className="wrap">
          <h2 id="garde-fous">L’IA écrit. Vous gardez la parole.</h2>
          <ul className="gardes">
            <li>
              <span className="tessere" aria-hidden="true" />
              <div>
                <h3>Rien d’inventé</h3>
                <p>
                  Ni chiffre, ni client, ni témoignage. À la place, un marqueur <mark className="marker">[À COMPLÉTER]</mark> qui bloque la publication.
                </p>
              </div>
            </li>
            <li>
              <span className="tessere" aria-hidden="true" />
              <div>
                <h3>Une seconde relecture</h3>
                <p>Une relecture indépendante compare chaque texte à vos sources, à votre ton et aux sujets à éviter.</p>
              </div>
            </li>
            <li>
              <span className="tessere" aria-hidden="true" />
              <div>
                <h3>Une personne décide toujours</h3>
                <p>Aucun post ne part sans l’accord de son titulaire ou de la personne qu’il a désignée.</p>
              </div>
            </li>
            <li>
              <span className="tessere" aria-hidden="true" />
              <div>
                <h3>Transparence sur l’IA</h3>
                <p>
                  Les images générées sont signalées, et le fonctionnement est <Link href="/comment-fonctionne-la-redaction">expliqué en détail</Link>.
                </p>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <section className="bloc" aria-labelledby="pour-qui">
        <div className="wrap">
          <h2 id="pour-qui">Pour qui</h2>
          <ul className="cartes">
            <li>
              <h3>PME et ETI</h3>
              <p>Faites parler vos dirigeants et vos experts régulièrement : la communication pilote, chacun valide ses posts.</p>
              <Link href="/pme-eti">Rostra pour les PME et ETI →</Link>
            </li>
            <li>
              <h3>Agences et freelances</h3>
              <p>Un espace par client, des validations sans aller-retour par e-mail, un rapport mensuel et l’usage exporté pour la refacturation.</p>
              <Link href="/agences">Rostra pour les agences →</Link>
            </li>
            <li>
              <h3>Sécurité et conformité</h3>
              <p>Vous devez rassurer votre DSI ou votre DPO ? Hébergement, sous-traitants, droits et données sont détaillés.</p>
              <Link href="/confiance">Sécurité et RGPD →</Link>
            </li>
          </ul>
        </div>
      </section>

      <section className="bloc blanc" aria-labelledby="fonctionnalites">
        <div className="wrap">
          <h2 id="fonctionnalites">Tout ce qu’il faut, de l’idée au post publié</h2>
          <ul className="bento">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <MiniVisuel type={f.visuel} />
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {testimonial !== null && (
        <section className="bloc" aria-labelledby="temoignage">
          <div className="wrap">
            <h2 id="temoignage">Ils l’utilisent</h2>
            <figure style={{ margin: 0 }}>
              <blockquote className="testimonial">
                <p>« {testimonial.quote} »</p>
              </blockquote>
              <figcaption>
                {testimonial.author}
                {testimonial.role && `, ${testimonial.role}`}
                {testimonial.company && ` · ${testimonial.company}`}
              </figcaption>
            </figure>
          </div>
        </section>
      )}

      <section id="tarifs" className="bloc teinte" aria-labelledby="tarifs-titre">
        <div className="wrap">
          <h2 id="tarifs-titre">Tarifs</h2>
          <p className="chapo">
            Un prix par compte LinkedIn actif, profil ou page. Paiement mensuel ou annuel, par carte ou prélèvement SEPA. <Link href="/tarifs">Voir le détail des formules</Link>.
          </p>
          <PlanCards plans={plans} />
          <PriceSimulator simulation={simulation} profiles={profiles} pages={pages} action="/#simulateur" />
        </div>
      </section>

      <section id="faq" className="bloc" aria-labelledby="faq-titre">
        <div className="wrap">
          <h2 id="faq-titre">Questions fréquentes</h2>
          <FaqList items={FAQ} />
        </div>
      </section>

      <section id="demo" className="bloc blanc" aria-labelledby="demo-titre">
        <div className="wrap demo-grille">
          <div>
            <h2 id="demo-titre">Demander une démonstration</h2>
            <p className="chapo">Montrez-nous votre situation : nombre de comptes, organisation, validation. Nous vous montrons ce que Rostra donnerait chez vous.</p>
            <ul className="coches">
              <li>Une démonstration sur votre cas</li>
              <li>Vos questions sur la sécurité et les données</li>
              <li>Une réponse sur la formule adaptée</li>
            </ul>
          </div>
          <div>
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
          </div>
        </div>
      </section>

      <FinalCta title="Prenez la parole." text="Testez Rostra sur vos propres comptes pendant 14 jours. Votre premier post d’exemple est rédigé à partir de votre site." />
    </main>
  );
}

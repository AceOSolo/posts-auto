import Link from 'next/link';
import { appUrl } from '../../../server/context.ts';
import { FaqList, type FaqItem, FinalCta, JsonLd, PageIntro, breadcrumbSchema, faqSchema, pageMetadata } from '../vitrine.tsx';

export const dynamic = 'force-dynamic';

export const metadata = pageMetadata(
  'Sécurité, RGPD et IA responsable | Rostra',
  'Comment Rostra protège vos comptes LinkedIn et vos données : autorisation officielle, jetons chiffrés, hébergement dans l’UE, validation humaine.',
  '/confiance',
);

const BLOCS: readonly { id: string; titre: string; points: readonly string[] }[] = [
  {
    id: 'comptes',
    titre: 'Vos comptes LinkedIn',
    points: [
      'Aucun mot de passe LinkedIn demandé : la connexion passe par l’autorisation officielle.',
      'Les jetons d’accès sont chiffrés au repos (AES-256-GCM) et ne sont jamais envoyés au navigateur.',
      'Chaque titulaire peut retirer son autorisation à tout moment.',
    ],
  },
  {
    id: 'acces',
    titre: 'Les accès à Rostra',
    points: [
      'Connexion par lien à usage unique, ou avec un compte Google ou Microsoft.',
      'Double authentification disponible.',
      'Rôles par espace : propriétaire, administrateur, éditeur, contributeur, lecteur.',
      'Isolation des clients appliquée dans la base de données.',
    ],
  },
  {
    id: 'donnees',
    titre: 'Vos données',
    points: [
      'Service et données hébergés dans l’Union européenne, avec une sauvegarde chaque nuit.',
      'Chaque personne peut télécharger les données qui la concernent.',
      'Les sous-traitants et leurs lieux de traitement sont publiés.',
      'Pas de cookie publicitaire sur le site.',
    ],
  },
  {
    id: 'ia',
    titre: 'L’usage de l’IA',
    points: [
      'La rédaction est confiée à Claude (Anthropic, États-Unis), sous clauses contractuelles types : vos textes ne servent pas à entraîner ses modèles.',
      'Seul ce qui est utile à la rédaction est transmis, jamais vos jetons LinkedIn.',
      'L’IA n’invente ni chiffre ni référence : un marqueur bloque la publication quand une information manque.',
      'Les images générées par IA sont signalées, sur la page du post et dans le texte alternatif publié.',
    ],
  },
];

const FAQ: readonly FaqItem[] = [
  { q: 'Mes contenus servent-ils à entraîner une IA ?', a: 'Non. Les textes envoyés à Claude, le modèle d’Anthropic, ne servent pas à entraîner ses modèles.' },
  { q: 'Mes données quittent-elles l’Union européenne ?', a: 'Le service et la base de données sont hébergés dans l’UE. Certains sous-traitants, comme Anthropic pour la rédaction, traitent des données aux États-Unis sous clauses contractuelles types. La liste complète est publiée.' },
  { q: 'Que devient mon compte si je pars ?', a: 'Vous pouvez exporter vos données. Après résiliation, leur conservation et leur suppression suivent les durées indiquées dans la politique de confidentialité.' },
  { q: 'Rostra est-il un produit de LinkedIn ?', a: 'Non. Rostra est un service indépendant édité par SimplX, qui utilise les interfaces officielles de LinkedIn. LinkedIn est une marque de LinkedIn Corporation.' },
];

export default function TrustPage() {
  return (
    <main className="site-main vitrine">
      <JsonLd data={[breadcrumbSchema(appUrl(), 'Sécurité et RGPD', '/confiance'), faqSchema(FAQ)]} />
      <PageIntro crumb="Sécurité et RGPD" title="Votre parole, vos comptes, vos données" lead="Publier au nom de quelqu’un demande de la confiance. Voici concrètement ce que Rostra fait pour la mériter, à transmettre à votre DSI ou à votre DPO." />

      <section className="bloc" aria-labelledby="engagements">
        <div className="wrap">
          <h2 id="engagements">Nos engagements, point par point</h2>
          <ul className="cartes">
            {BLOCS.map((b) => (
              <li key={b.id}>
                <h3>{b.titre}</h3>
                <ul className="coches">
                  {b.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="bloc blanc" aria-labelledby="documents">
        <div className="wrap">
          <h2 id="documents">Les documents à consulter</h2>
          <ul className="coches">
            <li>
              <Link href="/comment-fonctionne-la-redaction">Comment fonctionne la rédaction</Link>
            </li>
            <li>
              <Link href="/sous-traitants">Liste des sous-traitants</Link>
            </li>
            <li>
              <Link href="/confidentialite">Politique de confidentialité</Link>
            </li>
            <li>
              <Link href="/cgu">Conditions d’utilisation</Link>
            </li>
          </ul>
        </div>
      </section>

      <section className="bloc" aria-labelledby="faq-confiance">
        <div className="wrap">
          <h2 id="faq-confiance">Questions sur la sécurité</h2>
          <FaqList items={FAQ} />
        </div>
      </section>
      <FinalCta title="Une question de votre DSI ?" text="Demandez une démonstration, ou testez Rostra pendant 14 jours sans carte bancaire." />
    </main>
  );
}

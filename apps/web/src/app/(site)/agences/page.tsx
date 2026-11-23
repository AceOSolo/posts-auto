import Link from 'next/link';
import { appUrl } from '../../../server/context.ts';
import { FaqList, type FaqItem, FinalCta, JsonLd, PageIntro, breadcrumbSchema, faqSchema, pageMetadata } from '../vitrine.tsx';

export const dynamic = 'force-dynamic';

export const metadata = pageMetadata(
  'Outil LinkedIn pour agences et freelances | Rostra',
  'Gérez les posts LinkedIn de vos clients : un espace par client, rédaction par IA dans leur ton, validation sans aller-retour et rapport mensuel.',
  '/agences',
);

const POINTS: readonly (readonly [string, string])[] = [
  ['Un espace par client', 'Ligne éditoriale, comptes, planning, photos et équipe séparés. Un client ne voit jamais les données d’un autre.'],
  ['Des validations sans aller-retour','Votre client reçoit ses posts par e-mail et valide depuis son téléphone, sans créer de mot de passe.'],
  ['Un rapport mensuel prêt à envoyer', 'Publications, statistiques et enseignements du mois, en PDF, pour chaque client.'],
  ['L’usage exporté pour refacturer', 'Posts et images par espace et par mois, sur 12 mois, en CSV.'],
  ['Une voix par compte', 'Le ton de chaque dirigeant et de chaque marque est gardé, et s’affine avec les corrections.'],
  ['Des droits précis', 'Administrateur, éditeur, contributeur ou lecteur : chacun accède à ce qui le concerne, client par client.'],
];

const ETAPES: readonly (readonly [string, string])[] = [
  ['Créez l’espace du client', 'Renseignez son site et sa ligne éditoriale. Un premier post d’exemple montre le ton obtenu.'],
  ['Connectez ses comptes', 'Le client autorise lui-même son profil ou ses pages par la connexion officielle de LinkedIn.'],
  ['Lancez le planning', 'Vous posez les temps forts ; Rostra rédige les posts des deux semaines à venir.'],
  ['Pilotez, puis rendez compte', 'Vous suivez les validations de tous vos clients et envoyez le rapport du mois.'],
];

const FAQ: readonly FaqItem[] = [
  { q: 'Mes clients voient-ils qu’ils sont plusieurs ?', a: 'Non. Chaque client n’accède qu’à son espace. L’isolation des données est appliquée directement dans la base de données.' },
  { q: 'Qui paie l’abonnement ?', a: 'L’agence est facturée pour son organisation, tous espaces confondus, puis refacture ses clients comme elle le souhaite grâce à l’export de l’usage.' },
  { q: 'Un client peut-il valider sans compte Rostra ?', a: 'Oui : il reçoit un lien signé, propre à un post et à une personne, avec une page de confirmation avant toute action.' },
  { q: 'Puis-je valider à la place d’un client ?', a: 'Oui, si le titulaire du compte vous a désigné comme validateur. Chaque décision est tracée dans l’historique du post.' },
];

export default function AgenciesPage() {
  return (
    <main className="site-main vitrine">
      <JsonLd data={[breadcrumbSchema(appUrl(), 'Agences', '/agences'), faqSchema(FAQ)]} />
      <PageIntro crumb="Agences" title="Tous vos clients sur LinkedIn, sans courir après leurs validations" lead="Rostra donne aux agences et aux freelances un espace par client, une rédaction dans le ton de chacun et un circuit de validation que les clients utilisent vraiment." />

      <section className="bloc" aria-labelledby="atouts">
        <div className="wrap">
          <h2 id="atouts">Conçu pour gérer plusieurs marques</h2>
          <ul className="cartes">
            {POINTS.map(([titre, texte]) => (
              <li key={titre}>
                <h3>{titre}</h3>
                <p>{texte}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="bloc blanc" aria-labelledby="demarrer">
        <div className="wrap">
          <h2 id="demarrer">Un nouveau client en quatre étapes</h2>
          <ol className="semaine">
            {ETAPES.map(([titre, texte], index) => (
              <li key={titre}>
                <span className="quand">Étape {index + 1}</span>
                <p>
                  <strong>{titre}.</strong> {texte}
                </p>
              </li>
            ))}
          </ol>
          <p className="hint">
            La formule Agence inclut les espaces illimités et les rapports. <Link href="/tarifs">Voir les tarifs</Link>.
          </p>
        </div>
      </section>

      <section className="bloc" aria-labelledby="faq-agences">
        <div className="wrap">
          <h2 id="faq-agences">Questions des agences</h2>
          <FaqList items={FAQ} />
        </div>
      </section>
      <FinalCta title="Essayez sur un premier client." text="14 jours, 3 comptes LinkedIn et 10 posts rédigés, sans carte bancaire." />
    </main>
  );
}

import Link from 'next/link';
import { appUrl } from '../../../server/context.ts';
import { FaqList, type FaqItem, FinalCta, JsonLd, PageIntro, breadcrumbSchema, faqSchema, pageMetadata } from '../vitrine.tsx';

export const dynamic = 'force-dynamic';

export const metadata = pageMetadata(
  'LinkedIn pour PME et ETI : dirigeants et experts | Rostra',
  'Rendez vos dirigeants et experts visibles sur LinkedIn : posts rédigés par IA dans leur ton, validés par chacun, publiés automatiquement.',
  '/pme-eti',
);

const ROLES: readonly (readonly [string, string])[] = [
  ['Le dirigeant', 'Il retrouve ses posts sur son téléphone, écrits dans son ton. Il valide, corrige ou refuse, ou désigne une personne de confiance pour le faire.'],
  ['La communication', 'Elle tient le planning de tous les comptes et voit qui n’a pas répondu, pendant que les rappels partent tout seuls. Elle ne recopie plus rien d’un outil à l’autre.'],
  ['Les experts et commerciaux', 'Ils proposent une idée, même à la voix, puis reçoivent un post à relire. Leur expertise devient visible sans qu’ils aient à rédiger.'],
];

const USAGES: readonly (readonly [string, string])[] = [
  ['Marque employeur', 'Montrer les métiers et les équipes par la voix de ceux qui les exercent.'],
  ['Prospection', 'Installer vos commerciaux et vos experts comme des interlocuteurs reconnus dans votre secteur.'],
  ['Événements', 'Relayer un salon, une formation ou un lancement sur plusieurs comptes, chacun avec son angle.'],
  ['Prise de parole du dirigeant', 'Tenir une présence régulière, sur les sujets qu’il a choisis.'],
];

const FAQ: readonly FaqItem[] = [
  { q: 'Nos salariés doivent-ils utiliser leur profil personnel ?', a: 'Seulement s’ils le souhaitent. Chaque titulaire connecte lui-même son profil, valide ses posts et peut retirer son autorisation à tout moment.' },
  { q: 'Peut-on interdire certains sujets ?', a: 'Oui. La ligne éditoriale précise les formules interdites et les preuves autorisées, et chaque compte a ses propres sujets à éviter.' },
  { q: 'Qui voit les statistiques d’un profil personnel ?', a: 'Seuls le titulaire et les personnes qu’il a désignées pour valider à sa place.' },
  { q: 'Faut-il une personne dédiée ?', a: 'Il faut quelqu’un pour tenir le planning et suivre les validations, le plus souvent la personne en charge de la communication. La rédaction, les rappels et la publication sont pris en charge.' },
];

export default function SmePage() {
  return (
    <main className="site-main vitrine">
      <JsonLd data={[breadcrumbSchema(appUrl(), 'PME et ETI', '/pme-eti'), faqSchema(FAQ)]} />
      <PageIntro crumb="PME et ETI" title="Vos dirigeants et vos experts, enfin visibles sur LinkedIn" lead="Rostra organise la prise de parole de votre entreprise : un planning commun, des posts rédigés dans le ton de chacun, une validation qui tient dans la journée." />

      <section className="bloc" aria-labelledby="roles">
        <div className="wrap">
          <h2 id="roles">Chacun son rôle, et rien de plus</h2>
          <ul className="cartes">
            {ROLES.map(([titre, texte]) => (
              <li key={titre}>
                <h3>{titre}</h3>
                <p>{texte}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="bloc blanc" aria-labelledby="usages">
        <div className="wrap">
          <h2 id="usages">Ce que vos prises de parole peuvent servir</h2>
          <ul className="feature-grid">
            {USAGES.map(([titre, texte]) => (
              <li key={titre}>
                <h3>{titre}</h3>
                <p>{texte}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="bloc nuit" aria-labelledby="controle">
        <div className="wrap">
          <h2 id="controle">Votre image reste entre vos mains</h2>
          <p className="chapo">
            Rien ne part sans validation, l’IA n’invente ni chiffre ni référence, et chaque décision est tracée. <Link href="/confiance">Voir nos engagements de sécurité</Link>.
          </p>
        </div>
      </section>

      <section className="bloc" aria-labelledby="faq-pme">
        <div className="wrap">
          <h2 id="faq-pme">Questions des PME et ETI</h2>
          <FaqList items={FAQ} />
        </div>
      </section>
      <FinalCta title="Lancez la parole de vos équipes." text="Commencez avec trois comptes et dix posts, gratuitement pendant 14 jours." />
    </main>
  );
}

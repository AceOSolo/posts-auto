import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Todo } from '../legal.tsx';

export const metadata: Metadata = { title: 'Conditions générales d’utilisation', robots: { index: true, follow: true } };

/** SIT-04 : conditions générales d'utilisation. */
export default function TermsOfUsePage() {
  return (
    <LegalPage title="Conditions générales d’utilisation" updated="20 novembre 2026">
      <h2>1. Objet</h2>
      <p>
        Les présentes conditions régissent l’utilisation du service Posts LinkedIn : planification, rédaction assistée par intelligence artificielle, validation et publication de posts
        sur LinkedIn pour le compte d’une organisation cliente et des personnes qu’elle invite.
      </p>
      <h2>2. Comptes et accès</h2>
      <p>
        L’accès se fait par un lien de connexion envoyé par e-mail, ou par un compte Google ou Microsoft d’une adresse vérifiée. La double authentification est obligatoire pour les
        propriétaires et les administrateurs. Chacun est responsable de la confidentialité de sa messagerie et de ses appareils.
      </p>
      <h2>3. Validation et responsabilité des contenus</h2>
      <p>
        Aucun post n’est publié sans la validation de son titulaire ou d’une personne qu’il a désignée. Les textes proposés par l’IA peuvent contenir des erreurs : la personne qui valide
        reste responsable du contenu publié sous son nom ou celui de son organisation. Les marqueurs « À COMPLÉTER » et « À VÉRIFIER » doivent être traités avant publication. Voir{' '}
        <Link href="/comment-fonctionne-la-redaction">comment fonctionne la rédaction</Link>.
      </p>
      <h2>4. Connexion à LinkedIn</h2>
      <p>Chaque titulaire autorise la publication par l’autorisation officielle de LinkedIn et peut la retirer à tout moment. L’usage du service doit respecter les conditions de LinkedIn.</p>
      <h2>5. Contenus du client</h2>
      <p>Les contenus fournis ou validés par le client lui appartiennent. SimplX les traite uniquement pour rendre le service. Ils ne servent pas à entraîner des modèles d’IA tiers.</p>
      <h2>6. Usages interdits</h2>
      <p>Il est interdit d’utiliser le service pour publier des contenus illicites, trompeurs, haineux ou portant atteinte aux droits d’autrui, ou pour contourner les limites de LinkedIn.</p>
      <h2>7. Disponibilité</h2>
      <p>
        SimplX fait ses meilleurs efforts pour assurer la disponibilité du service. Les opérations de maintenance sont annoncées dans l’application. <Todo>engagement de niveau de service éventuel</Todo>
      </p>
      <h2>8. Données personnelles</h2>
      <p>
        Voir la <Link href="/confidentialite">politique de confidentialité</Link>.
      </p>
      <h2>9. Droit applicable</h2>
      <p>
        Droit français. <Todo>tribunal compétent</Todo>
      </p>
    </LegalPage>
  );
}

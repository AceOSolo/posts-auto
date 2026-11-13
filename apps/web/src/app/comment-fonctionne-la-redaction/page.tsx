import { CONTENT_REPORT_DELAY } from '@posts-auto/services';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Comment fonctionne la rédaction' };

/** GEN-12 : transparence sur la rédaction par l'IA, exigée par les règles de LinkedIn. Page publique. */
export default function HowWritingWorksPage() {
  return (
    <main>
      <p>
        <Link href="/">← Accueil</Link>
      </p>
      <h1>Comment fonctionne la rédaction</h1>
      <p>
        Les posts proposés dans cette application sont <strong>rédigés par une intelligence artificielle</strong>, puis{' '}
        <strong>validés par une personne</strong> avant toute publication. Rien ne part sur LinkedIn sans l’accord du titulaire du compte ou
        de la personne qu’il a désignée pour valider à sa place.
      </p>

      <h2>Avec quelles sources</h2>
      <p>L’IA s’appuie uniquement sur ce que votre équipe a renseigné :</p>
      <ul>
        <li>le planning éditorial, la banque de sujets, les événements à relayer, les idées et les demandes de post ;</li>
        <li>la ligne éditoriale de l’entreprise (positionnement, cibles, ton, formules interdites, preuves autorisées) et l’état de l’offre ;</li>
        <li>la fiche de chaque compte : voix, ton, sujets à éviter, exemples de posts à imiter ou à éviter, préférences du titulaire.</li>
      </ul>
      <p>
        Les contenus venus de l’extérieur (articles, demandes rédigées librement, posts collés en exemple) sont traités comme des données :
        une consigne qui s’y trouverait (« ignore tes règles… ») n’est jamais appliquée et elle est signalée à l’équipe.
      </p>

      <h2>Ce que l’IA s’interdit</h2>
      <ul>
        <li>
          Elle n’invente ni chiffre, ni date, ni nom de client, ni témoignage, ni référence réglementaire. Quand une information manque, elle
          laisse un marqueur <strong>[À COMPLÉTER]</strong> ; quand une information doit être vérifiée, un marqueur{' '}
          <strong>[À VÉRIFIER]</strong>. Un post qui contient encore un marqueur ne peut pas être validé.
        </li>
        <li>Elle ne présente comme disponible que ce que l’état de l’offre marque comme disponible.</li>
        <li>Elle respecte les règles de rédaction de l’entreprise : par défaut, aucun hashtag, aucune mention, liens en fin de texte.</li>
      </ul>

      <h2>Comment chaque post est vérifié</h2>
      <ol>
        <li>Une première IA rédige le post.</li>
        <li>
          Une seconde relecture, indépendante, compare le texte aux sources : faits non sourcés, offres présentées à tort, ton, sujets à
          éviter.
        </li>
        <li>Des contrôles automatiques vérifient les règles mesurables : hashtags, mentions, place des liens, longueur, phrases déjà publiées.</li>
        <li>
          S’il reste un problème après une correction, le post est proposé avec un marqueur [À VÉRIFIER] qui explique quoi regarder : il ne
          part pas tant qu’une personne ne l’a pas traité.
        </li>
      </ol>

      <h2>Votre rôle</h2>
      <p>
        <strong>L’IA peut se tromper.</strong> Avant de valider, relisez le post comme s’il venait d’un collaborateur : faits, chiffres,
        noms, ton. Vous pouvez le corriger, demander une modification (l’IA en rédige une nouvelle version) ou le refuser (l’IA propose un
        autre sujet). Vos corrections servent à mieux écrire pour vous les fois suivantes ; le résumé de ce qui a été appris est visible et
        modifiable sur la fiche de votre compte.
      </p>

      <h2>Vos données</h2>
      <ul>
        <li>
          La rédaction est confiée à Claude, le modèle d’Anthropic, qui agit comme sous-traitant. Les textes qui lui sont envoyés ne servent
          pas à entraîner ses modèles.
        </li>
        <li>Seul ce qui est utile à la rédaction lui est transmis : sources, ligne éditoriale, fiche du compte. Jamais vos jetons LinkedIn.</li>
        <li>Les statistiques LinkedIn des profils personnels ne servent à la rédaction qu’avec l’accord du titulaire.</li>
      </ul>

      <h2>Signaler un contenu</h2>
      <p>
        Chaque post porte un bouton « Signaler un contenu ». L’éditeur du produit examine chaque signalement sous {CONTENT_REPORT_DELAY}.
      </p>
    </main>
  );
}

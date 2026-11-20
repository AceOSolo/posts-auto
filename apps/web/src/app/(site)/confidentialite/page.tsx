import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Todo } from '../legal.tsx';

export const metadata: Metadata = { title: 'Politique de confidentialité', robots: { index: true, follow: true } };

/** SIT-04 : politique de confidentialité (RGPD). */
export default function PrivacyPage() {
  return (
    <LegalPage title="Politique de confidentialité" updated="20 novembre 2026">
      <h2>Responsables du traitement</h2>
      <p>
        Pour le site vitrine et la gestion des clients, SimplX est responsable du traitement. Pour les données traitées dans le service pour le compte d’une organisation cliente (posts,
        membres, comptes LinkedIn), l’organisation est responsable du traitement et SimplX agit comme sous-traitant. Contact : <Todo>adresse e-mail du délégué ou du référent RGPD</Todo>.
      </p>
      <h2>Données traitées</h2>
      <ul>
        <li>Compte : nom, adresse e-mail, rôle, historique de connexion (adresse IP, navigateur), double authentification.</li>
        <li>LinkedIn : identifiant, nom et photo du profil ou de la page, jetons d’accès chiffrés, statistiques des posts publiés.</li>
        <li>Contenus : ligne éditoriale, posts, corrections, décisions, photos et visuels.</li>
        <li>Facturation : coordonnées de facturation et historique des paiements (traités par Stripe ; les données de carte ne sont pas conservées par SimplX).</li>
        <li>Demande de démonstration : nom, entreprise, e-mail, téléphone, nombre de comptes.</li>
      </ul>
      <h2>Finalités et bases légales</h2>
      <ul>
        <li>Fournir le service : exécution du contrat.</li>
        <li>Sécurité (journal d’accès, journal d’audit) : intérêt légitime.</li>
        <li>Facturation : obligation légale et exécution du contrat.</li>
        <li>Réponse aux demandes de démonstration : mesures précontractuelles.</li>
        <li>Apprentissage des préférences de rédaction d’un titulaire : consentement, recueilli à la connexion de son compte et retirable.</li>
      </ul>
      <h2>Intelligence artificielle</h2>
      <p>
        Les textes sont rédigés par un modèle d’IA (Anthropic) à partir des informations de l’espace. Ces données ne servent pas à entraîner les modèles du fournisseur. Les images générées
        sont signalées comme telles.
      </p>
      <h2>Durées de conservation</h2>
      <p>
        Pendant l’abonnement, puis 90 jours après sa fin ou sa suspension, sauf obligations légales (factures : 10 ans). Demandes de démonstration : 3 ans après le dernier contact.{' '}
        <Todo>durées à confirmer</Todo>
      </p>
      <h2>Sous-traitants</h2>
      <p>
        Voir la <Link href="/sous-traitants">liste des sous-traitants</Link>. Les données sont hébergées dans l’Union européenne ; les transferts hors UE éventuels sont encadrés par les
        clauses contractuelles types.
      </p>
      <h2>Vos droits</h2>
      <p>
        Accès, rectification, effacement, limitation, opposition et portabilité. Chacun peut télécharger toutes ses données depuis « Mon compte ». Pour exercer vos droits : <Todo>adresse de
        contact</Todo>. Vous pouvez aussi saisir la CNIL (cnil.fr).
      </p>
    </LegalPage>
  );
}

import type { Metadata } from 'next';
import { LegalPage, Todo } from '../legal.tsx';

export const metadata: Metadata = { title: 'Conditions générales de vente', robots: { index: true, follow: true } };

/** SIT-04 : conditions générales de vente (abonnements, décision 0007). */
export default function TermsOfSalePage() {
  return (
    <LegalPage title="Conditions générales de vente" updated="20 novembre 2026">
      <h2>1. Clients</h2>
      <p>Le service est destiné aux professionnels (entreprises, agences, indépendants). Les présentes conditions s’appliquent à tout abonnement.</p>
      <h2>2. Essai gratuit</h2>
      <p>Essai de 14 jours, sans carte bancaire, limité à 3 comptes LinkedIn et 10 posts rédigés. À la fin de l’essai, la rédaction s’arrête ; les posts déjà validés partent toujours.</p>
      <h2>3. Prix et facturation</h2>
      <p>
        Prix hors taxes, par compte LinkedIn actif et par mois, selon la formule affichée sur la page Tarifs au jour de la souscription. Paiement mensuel ou annuel, par carte ou
        prélèvement SEPA, par l’intermédiaire de Stripe. Un compte ajouté en cours de période est facturé au prorata ; un compte retiré cesse d’être facturé à la période suivante. La
        TVA applicable est ajoutée ; l’autoliquidation s’applique aux clients assujettis d’un autre État membre.
      </p>
      <h2>4. Quotas et dépassement</h2>
      <p>
        Chaque formule comprend un nombre de posts rédigés par compte et par mois, mis en commun dans l’espace et remis à zéro chaque mois à la date anniversaire. Au plafond, la rédaction
        s’arrête jusqu’au mois suivant, ou des packs supplémentaires sont achetés, au choix du client.
      </p>
      <h2>5. Résiliation</h2>
      <p>
        Le client résilie depuis le portail de facturation ; l’abonnement prend fin à l’échéance de la période en cours. <Todo>durée d’engagement des abonnements annuels, remboursement éventuel</Todo>
      </p>
      <h2>6. Impayés</h2>
      <p>
        En cas d’échec de paiement, des relances sont envoyées à J+3 et J+7. À J+14, la rédaction et la publication sont suspendues jusqu’au règlement. Les données sont conservées 90 jours
        après la suspension, puis supprimées.
      </p>
      <h2>7. Responsabilité</h2>
      <p>
        <Todo>limitation de responsabilité, plafond</Todo>
      </p>
      <h2>8. Droit applicable</h2>
      <p>
        Droit français. <Todo>tribunal compétent</Todo>
      </p>
    </LegalPage>
  );
}

# 0007 – Facturation : abonnement Stripe, quotas, impayés

20 novembre 2026 · statut : adopté · lot 2 (FAC-01 à FAC-07, RÈG-19, RÈG-20)

## Contexte

Le lot 2 ouvre l'outil à des clients qui paient seuls. Ce que fixe le cahier des charges :

- **FAC-01** : paiement par carte et prélèvement SEPA via Stripe, factures conformes (TVA française, autoliquidation dans l'UE) et facture électronique selon le calendrier de la réforme ;
- **FAC-02** : quantité facturée égale au nombre de comptes actifs. Un ajout est facturé au prorata, un retrait prend effet à la période suivante ;
- **FAC-03** : paiement mensuel ou annuel, codes promo ;
- **FAC-04** : compteurs d'usage visibles par le client. Au plafond, le client choisit entre l'arrêt de la rédaction et l'achat de packs ;
- **FAC-05** : portail client Stripe ;
- **FAC-06** : relances à J+3 et J+7, suspension à J+14, données conservées 90 jours ;
- **FAC-07** : l'agence est facturée pour son organisation et reçoit un export des usages par espace ;
- **RÈG-19** : seules les premières rédactions comptent, chaque image générée compte ;
- **RÈG-20** : le quota est mensuel et remis à zéro à la date anniversaire, avec une alerte à 80 %.

Les prix et le contenu exact des formules ne sont pas encore décidés par SimplX.

## Décisions

1. **Stripe est la référence, la base en est le reflet.** L'abonnement n'est écrit qu'à partir des événements Stripe (`applyBillingEvent`). Chaque événement est appliqué une seule fois, grâce à la table `billing_events`. La page de paiement (Stripe Checkout) et le portail sont ceux de Stripe. Stripe prend donc en charge la carte, le SEPA, la TVA (`automatic_tax`), la collecte du numéro de TVA intracommunautaire, les codes promo et les factures.

   Stripe est appelé par son API REST (`fetch`), sans SDK. Il n'y a que quatre appels : client, session de paiement, portail, quantité. Les événements reçus sont traduits en événements internes (`BillingEvent`), si bien que le reste du code ne dépend pas de Stripe.
2. **Formules configurables en base, prix dans Stripe.** La table `plans` porte, pour chaque formule :
   - les posts et images par compte et par mois ;
   - le nombre d'espaces ;
   - les fonctions incluses ;
   - les identifiants des prix Stripe, mensuel et annuel.

   Une formule sans identifiant de prix n'est pas proposée. Les prix affichés (`price_*_cents`, hors taxes) ne servent qu'à l'affichage : le montant facturé reste celui du prix Stripe. Trois formules sont créées, sans prix : Essentiel (16 posts par compte), Pro (32) et Agence (32, espaces illimités). Fixer les prix ne demande aucun développement.
3. **Un seul calcul de droits : `allowanceForWorkspace`.** La rédaction (hebdomadaire, demandes, reprises), les visuels et les pages lisent la même fonction. Elle renvoie l'un des cinq cas suivants :

   | Cas | Rédaction | Publication |
   | --- | --- | --- |
   | Pilote : organisation créée à la main, sans essai (Secutop) | sans limite | oui |
   | Essai | 10 posts, 14 jours | oui |
   | Essai terminé ou abonnement résilié | arrêtée | oui |
   | Abonné | quota de la formule multiplié par les comptes facturés de l'espace, plus les packs, sur le mois de quota | oui |
   | Suspendu (impayé depuis 14 jours, ou résilié pendant un impayé) | arrêtée | non |

   - Le quota est mutualisé dans l'espace [C6].
   - Le mois de quota part de la date anniversaire, y compris pour un abonnement annuel (RÈG-20). Un abonnement commencé le 31 se renouvelle le dernier jour des mois plus courts.
   - Un paiement commencé mais pas abouti ne prolonge pas l'essai : sa fin se lit sur la date.
4. **Quantité synchronisée par la tâche de fond, pas à chaque connexion.** Toutes les heures, la tâche « facturation » compare le nombre de comptes facturés de l'organisation à la quantité Stripe :
   - les comptes facturés sont les comptes connectés, ceux qui expirent bientôt et ceux qui ont expiré ; un compte en pause ou déconnecté ne l'est pas ;
   - une hausse est transmise à Stripe au prorata ;
   - une baisse est transmise sans prorata, donc prise en compte à la période suivante (FAC-02).

   Ce mode de calcul évite qu'une erreur Stripe bloque la connexion d'un compte.
5. **Impayés (FAC-06).** Stripe signale l'échec d'un prélèvement. L'organisation passe alors « en retard » et la date du premier impayé est conservée. La tâche « facturation » prend ensuite le relais :
   - elle envoie aux propriétaires une relance à J+3, puis à J+7 ;
   - à J+14, elle suspend l'organisation : ni rédaction ni publication, la file de publication sautant déjà les organisations suspendues ;
   - un règlement lève la suspension ;
   - une résiliation pendant un impayé maintient la suspension ;
   - 90 jours après la suspension, l'organisation est supprimée avec toutes ses données, en cascade, et ses images sont effacées du stockage.
6. **Au plafond (FAC-04).** Le client choisit entre deux options :
   - « la rédaction s'arrête », le choix par défaut ;
   - « packs supplémentaires ».

   Un pack est un paiement Stripe unique, rattaché à un espace et au mois de quota en cours. Les administrateurs et les propriétaires reçoivent une alerte à 80 % puis à 100 %, une seule fois par seuil et par mois, par e-mail et dans l'application.
7. **Agences (FAC-07).** L'agence est facturée pour son organisation, tous espaces confondus. Le propriétaire exporte en CSV l'usage par espace et par mois sur 12 mois (posts, images, coût estimé de l'IA) pour refacturer ses clients en dehors de l'outil.
8. **Mode simulé (`BILLING_MODE=fake`).** La page de paiement et le portail sont remplacés par une page de l'application qui applique les événements qu'enverrait Stripe : paiement, résiliation, échec et réussite d'un prélèvement. Ce mode permet de développer, de faire une démonstration et de passer le test de fumée sans compte Stripe. Dans tout autre mode, cette page est introuvable.

## Conséquences

- **Mise en service.** Il faut :
  - créer les produits et les prix dans Stripe (tarif par unité, une unité par compte) ;
  - renseigner `plans.stripe_price_*` et `quota_pack_offers.stripe_price` ;
  - activer Stripe Tax et le portail client ;
  - déclarer l'adresse `/api/stripe/webhook` pour les événements `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid` et `invoice.payment_failed` ;
  - définir `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET`.
- **Facture électronique (M10).** Stripe n'est pas une plateforme agréée. Le raccordement de Stripe à une plateforme agréée se fait hors du code, avant l'échéance qui concerne l'entité qui facture.
- **Organisations pilotes.** Une organisation sans date de fin d'essai et sans abonnement n'a aucune limite. Si elle souscrit puis résilie, elle passe au cas « résilié », pas au cas « pilote ».
- **Nombre d'espaces.** La limite d'espaces par formule (`max_workspaces`) s'applique à la création d'un espace par une agence.

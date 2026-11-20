# Avancement de l'incrément 2b « Abonnement et facturation »

Périmètre : lot 2, exigences FAC-01 à FAC-07, RÈG-19 et RÈG-20 (décision 0007).

**En résumé (20 novembre 2026)** : un client en essai peut choisir une formule et payer, en mensuel ou en annuel. Il suit l'usage du mois par espace et choisit ce qui se passe au plafond. Il gère son paiement, ses factures et sa résiliation dans le portail. Les impayés sont relancés, puis l'organisation est suspendue. Le tout fonctionne en mode simulé (`BILLING_MODE=fake`). Le passage à Stripe demande seulement la configuration décrite plus bas, sans développement.

Les 759 tests automatiques passent, ainsi que les 112 vérifications du test de fumée. Celui-ci parcourt la souscription, le choix au plafond, le portail, l'impayé puis le règlement, l'export et le webhook signé.

## Ce qui est fait

| Exigence | Ce qui est fait |
| --- | --- |
| FAC-01 | Souscription par Stripe Checkout : carte et SEPA, TVA calculée par Stripe, numéro de TVA intracommunautaire collecté. Webhook signé `/api/stripe/webhook`, chaque événement appliqué une seule fois. |
| FAC-02 | Quantité facturée égale au nombre de comptes actifs, synchronisée toutes les heures. Un ajout est facturé au prorata, un retrait compte à la période suivante. |
| FAC-03 | Paiement mensuel ou annuel, au choix pour chaque formule ; codes promo saisis sur la page de paiement. |
| FAC-04 | Page « Abonnement » : usage du mois par espace (posts, images). Au plafond, le client choisit l'arrêt de la rédaction ou les packs, achetés pour un espace et pour le mois. Alerte à 80 % puis à 100 %, par e-mail et dans l'application. |
| FAC-05 | Portail Stripe : moyen de paiement, factures, changement de formule, résiliation. |
| FAC-06 | Relances à J+3 et J+7, suspension de la rédaction et de la publication à J+14, levée de la suspension au règlement. Suppression des données 90 jours après la suspension. |
| FAC-07 | Export CSV de l'usage par espace et par mois sur 12 mois (posts, images, coût estimé de l'IA), pour le propriétaire. |
| RÈG-19 et RÈG-20 | Seules les premières rédactions comptent. Quota mensuel remis à zéro à la date anniversaire, y compris en annuel. |

**Espaces des agences** : page « Clients » (ou « Espaces » pour une entreprise), réservée au propriétaire. Une agence crée un espace par client, cloisonné, et passe directement à son assistant de démarrage. Le nombre d'espaces suit la formule (`max_workspaces`). Sans abonnement :

- une entreprise a un seul espace ;
- une agence en essai et un client pilote ne sont pas limités.

Le bandeau d'essai mène maintenant à la page « Abonnement » : « Souscrire », ou « Choisir une formule » une fois l'essai terminé.

## Ce qui attend une action ou une décision

1. **SimplX : prix des formules et des packs.** Il faut fixer les prix, puis :
   - créer les prix dans Stripe ;
   - renseigner `plans.stripe_price_monthly` et `plans.stripe_price_yearly`, ainsi que `quota_pack_offers.stripe_price` ;
   - renseigner les prix affichés (`price_monthly_cents`, `price_yearly_cents`, `price_cents`).

   Les quotas actuels (16 et 32 posts par compte) sont à confirmer. En attendant, une formule sans prix est affichée « Bientôt disponible ».
2. **SimplX : compte Stripe.** Il faut :
   - activer Stripe Tax et le portail client (changement de formule autorisé) ;
   - déclarer le webhook et ses six événements (décision 0007) ;
   - définir `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` sur le serveur et pour les tâches de fond.
3. **SimplX : facture électronique (M10).** Il faut raccorder Stripe à une plateforme agréée avant l'échéance qui concerne l'entité qui facture.

# Avancement de l'incrément 2d « Back-office de l'éditeur »

Périmètre : lot 2, exigences ADM-01 à ADM-06 (décision 0008).

**En résumé (20 novembre 2026)** : SimplX dispose d'un back-office (`/admin`), réservé à ses équipes et protégé par la double authentification. Il couvre :

- la liste et la fiche des organisations ;
- la supervision ;
- les paramètres par défaut, avec les modèles d'IA et les consignes ;
- la galerie de départ ;
- les annonces ;
- l'intervention du support avec l'accord du client.

Les 772 tests automatiques passent, ainsi que les 135 vérifications du test de fumée, qui parcourent tout le back-office.

| Exigence | Ce qui est fait |
| --- | --- |
| ADM-01 | Liste des organisations : formule, état de paiement, espaces, comptes actifs, posts et images du mois, coût de l'IA du mois, revenu mensuel hors taxes, dernière activité. Totaux et recherche par nom. Fiche d'une organisation : abonnement, espaces, personnes (rôles, dernière connexion, double authentification). |
| ADM-02 | Accès du support accordé par le client, pour 1 à 72 heures, dans « Réglages ». Session au nom du client, avec un bandeau. Accord, ouverture, fin et retrait inscrits au journal d'audit du client. |
| ADM-03 | Supervision :<br>• files de rédaction, de demandes, de visuels et de publication (retards, erreurs) ;<br>• erreurs LinkedIn par type sur 7 jours ;<br>• connexions qui expirent ;<br>• coûts de l'IA par fournisseur, ce mois-ci et le mois dernier. |
| ADM-04 | Valeurs par défaut des nouveaux espaces et comptes. Modèle d'IA en service, modèles utilisés sur 30 jours, rédactions par version de consignes, texte des consignes. |
| ADM-05 | Galerie de départ : aperçus, retrait d'un modèle intégré, ajout de modèles en JSON aux couleurs de chaque espace. |
| ADM-06 | Annonces d'information ou de maintenance, programmées, affichées en bandeau à tous. |

## Ce qui attend une action

- **SimplX** : donner l'accès au back-office avec `npm run admin:add -w @posts-auto/db -- prenom.nom@simplx.fr`. La personne doit déjà avoir un compte.

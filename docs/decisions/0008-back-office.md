# 0008 – Back-office de l'éditeur

20 novembre 2026 · statut : adopté · lot 2 (ADM-01 à ADM-06)

## Contexte

SimplX doit suivre ses clients et intervenir chez eux sans jamais affaiblir le cloisonnement entre clients (REC-01). Le cahier fixe six besoins :

- **ADM-01** : liste des organisations ;
- **ADM-02** : connexion « en tant que » avec l'accord du client ;
- **ADM-03** : supervision ;
- **ADM-04** : paramètres globaux ;
- **ADM-05** : galerie de départ ;
- **ADM-06** : annonces.

## Décisions

1. **Accès limité aux personnes inscrites dans `platform_admins`.** On les ajoute en ligne de commande (`npm run admin:add -w @posts-auto/db -- adresse`), jamais depuis l'application. Le back-office exige la double authentification **active**, sans délai de grâce.
   - Pour quelqu'un d'autre, `/admin` répond « introuvable » : son existence n'est pas révélée.
   - Les lectures portent sur tous les clients et passent par l'identité système, une fois l'accès vérifié.
   - Il n'y a aucun contenu de post dans le back-office : seulement des compteurs, des états et des coûts.
2. **ADM-01 : organisations.**
   - **Revenu mensuel récurrent** : prix affiché multiplié par la quantité facturée. Un abonnement annuel est compté pour un douzième du prix annuel. Stripe reste la référence pour le revenu réel.
   - **État de paiement** : déduit de l'abonnement et du statut de l'organisation.
   - **Dernière activité** : la plus récente entre les sessions des membres (hors support) et le journal d'audit.
3. **ADM-02 : intervention du support, en trois temps.**
   - Le propriétaire ou un administrateur de l'espace accorde l'accès pour 1 à 72 heures, dans « Réglages ».
   - Une personne de l'éditeur ouvre une session **au nom de qui a accordé l'accès** et voit l'espace comme cette personne le voit.
   - La session finit à la fin de l'accord. Elle n'est jamais prolongée. Le retrait de l'accès ferme ses sessions.

   **Traçabilité.** Le journal d'audit de l'espace trace l'accord, l'ouverture, la fin et le retrait (acteur « support », avec l'adresse de la personne de l'éditeur). Un bandeau signale la session pendant toute sa durée. Dans le navigateur de la personne de l'éditeur, la session du support remplace la sienne : elle se reconnecte ensuite.
4. **ADM-04 : paramètres globaux.**
   - **Valeurs par défaut**, appliquées aux espaces et aux comptes créés ensuite :
     - le budget d'images ;
     - les limites de planification ;
     - le nombre de posts par semaine ;
     - la part d'images générées.
   - **Modèle d'IA et consignes** : le modèle reste un réglage du serveur (`AI_MODEL`) et les consignes restent dans le code, versionnées par `PROMPT_VERSION`, qui est enregistrée sur chaque rédaction.

     Le back-office les **montre** : le modèle en service, les modèles réellement utilisés sur 30 jours avec leur coût, les rédactions par version de consignes et le texte des consignes en vigueur. Changer une consigne est une mise en production relue et testée, pas un réglage à chaud. C'est le choix de la décision 0005.
5. **ADM-05 : galerie de départ.**
   - Les modèles intégrés au code peuvent être retirés.
   - L'éditeur ajoute ses modèles en JSON. Ils utilisent les jetons `brand.primary`, `brand.secondary`, `brand.light`, `brand.dark` et `brand.font`, remplacés par la charte de chaque espace.
   - Chaque modèle est vérifié à l'enregistrement par le même contrôle que l'éditeur des clients.
   - Seuls les espaces qui n'ont pas encore reçu leurs modèles sont concernés.
6. **ADM-06 : annonces.** Une annonce est un message d'information ou de maintenance, avec une date de début et une date de fin. Elle s'affiche en bandeau pour tous les utilisateurs, trois annonces au plus à la fois.

## Conséquences

- **Mise en service** : ajouter les personnes de SimplX avec `admin:add`. À leur première visite, elles activent la double authentification.
- **Pas de mise à jour en masse** : un changement de paramètres ou de galerie ne modifie pas les espaces existants.

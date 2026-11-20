# Avancement après le lot 2 : mise en production et améliorations

Tout ce qui ne dépend ni de vos comptes ni de vos décisions est fait et testé. Ce qui reste à faire de votre côté est listé à la fin.

## Mise en production (fait, 20 novembre 2026)

- **Image Docker unique** : application web, tâches de fond, migrations, vérification des intégrations. Elle est publiée sur `ghcr.io/aceosolo/posts-auto` à chaque envoi sur `main` dont les vérifications passent.
- **Serveur** : `deploy/compose.prod.yaml` lance PostgreSQL, les migrations, l'application, les tâches de fond et Caddy (HTTPS automatique). Une sauvegarde chaque nuit : base et médias, gardés 14 jours.
- **Marche à suivre** : [deploiement.md](./deploiement.md) (installation, mise à jour, restauration d'une sauvegarde, supervision). La pile a été essayée de bout en bout sur un poste : migrations, page `/sante`, rendu des visuels dans le conteneur, sauvegarde puis restauration.
- **Vérification des intégrations** : `verifier-integrations` contrôle chaque service une fois les clés posées, sans rien modifier. Il couvre HTTPS, la base, le chiffrement, Anthropic, Brevo, Stripe (prix et webhook), LinkedIn, Google, Microsoft et Canva. La recette manuelle est dans [recette-integrations.md](./recette-integrations.md).

## Tests dans le navigateur (fait, 20 novembre 2026)

- **36 tests Playwright**, chacun joué deux fois : sur ordinateur et sur téléphone (Pixel 7).
  - Le site vitrine : accueil, simulateur de prix, demande de démonstration, version anglaise, pages légales, connexion, inscription.
  - L'application : « Mes posts », marqueur qui bloque la validation, validation d'un post, pages de gestion, fiche d'un compte, démarrage.
- **Vérifications de chaque page** : pas de défilement horizontal, aucune violation d'accessibilité grave (WCAG 2.1 AA, contrôle automatique axe).
- **Défaut trouvé et corrigé** : les tableaux défilables n'étaient pas atteignables au clavier.
- **Intégration continue** : un travail « navigateur » joue ces tests à chaque envoi. En cas d'échec, il joint le rapport, les traces et le journal du serveur.
- Commande : `npm run e2e -w @posts-auto/web`, avec l'application lancée et après le seed.

## Meilleurs moments pour publier (fait, 20 novembre 2026)

- **Où** : sur la fiche de chaque compte. L'engagement y est classé par moment de la semaine (jour et tranche horaire).
- **Mesure** : statistiques LinkedIn relevées à J+7, sur les posts des six derniers mois. L'engagement se compte en interactions pour 1 000 impressions, ou en interactions par post quand LinkedIn ne donne pas les impressions.
- **Conseil** : un moment n'est proposé que s'il se détache nettement (au moins 20 % au-dessus de la moyenne). Il faut au moins 6 posts mesurés en tout, et 2 par moment. Sans assez de données, la fiche le dit et ne conseille rien.
- **Bouton « Ajouter le créneau du … »** : ajoute le moment proposé aux créneaux habituels du compte.

## Post d'exemple dès l'inscription (fait, 20 novembre 2026)

- **Le résultat tout de suite** : sur la page de démarrage, « Rédiger un post d'exemple à partir de mon site ». L'IA lit la page d'accueil et rédige un post, affiché dans l'aperçu LinkedIn. C'est possible avant même de connecter LinkedIn, donc pendant que l'accès à l'API est en attente.
- **Mêmes règles que la rédaction** : rien d'inventé (marqueurs [À COMPLÉTER]), et les consignes cachées dans le site sont ignorées.
- **Pas un vrai post** : il n'est jamais publié ni compté dans le quota. 5 exemples au plus par heure et par espace.

## Messagerie d'équipe : Slack ou Microsoft Teams (fait, 20 novembre 2026)

- **Où** : dans les réglages de l'espace, l'administrateur relie un canal Slack (webhook entrant) ou Teams (flux Workflows).
- **Ce qui est annoncé** :
  - les posts prêts à valider ;
  - les échecs de publication ;
  - les posts publiés, avec leur lien LinkedIn.
- **Relais par les collaborateurs** : le message du post publié invite l'équipe à réagir et commenter dans la première heure, ce qui aide le post à être vu.
- **Sécurité** : l'adresse du webhook est chiffrée et jamais réaffichée. Seules les adresses officielles de Slack et de Microsoft sont admises.
- **Envoi** : un message par événement, avec un bouton de message d'essai. Une erreur passagère est réessayée (5 fois au plus). Un webhook révoqué est signalé dans les réglages.

## Décliner un article en idées (fait, 20 novembre 2026)

- **Où** : dans la boîte à idées, « Décliner un article en idées ».
- **Fonctionnement** : on colle l'adresse d'un article (blog, média, page du site). L'IA en tire trois angles distincts : un conseil, un fait marquant, une question… Ils deviennent des idées pour tous les comptes, avec le lien de l'article.
- **Règles** : rien d'inventé au-delà de l'article, et la lecture de la page est protégée (réseau interne refusé). 10 déclinaisons par heure et par personne.

## Écarté pour l'instant : suivi et réponse aux commentaires

LinkedIn ne permet ce suivi qu'en partie :
- pour les **pages**, la lecture et la réponse passent par la Community Management API, sur une autorisation que LinkedIn accorde au cas par cas ;
- pour les **profils personnels**, l'API ne donne pas aux applications tierces la lecture des commentaires.

Le suivi des commentaires est donc à reprendre quand l'accès à la Community Management API sera accordé, et pour les pages seulement. En attendant, le message « post publié » de la messagerie d'équipe renvoie chacun vers le post.

## Ce qui reste à faire de votre côté

1. **LinkedIn** : demander l'accès à la Community Management API, nécessaire pour publier sur les pages et lire les statistiques. C'est le délai le plus long.
2. **Hébergement** : choisir le serveur et le nom de domaine, puis suivre [deploiement.md](./deploiement.md).
3. **Clés et comptes** : Anthropic, Brevo (expéditeur vérifié), Stripe (prix et webhook), Google et Microsoft (connexion), Canva si besoin. Ensuite, lancer `verifier-integrations`.
4. **Tarifs** : fixer les prix des formules et des packs dans Stripe.
5. **Textes légaux** : faire relire les mentions légales, les CGU, les CGV et la politique de confidentialité par un juriste.
6. **Pilote Secutop** : quelques semaines d'usage réel, avec la recette [recette-integrations.md](./recette-integrations.md).
7. **Test d'intrusion** (SEC-10) : le confier à un prestataire, sur la base de [test-intrusion.md](./test-intrusion.md).

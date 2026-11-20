# Avancement de l'incrément 2e « Fonctions complémentaires du lot 2 »

Périmètre : exigences du lot 2 classées S (souhaitées) ou C (confort) qui ne relèvent ni de la facturation, ni de la sécurité, ni du back-office.

## PUB-09 : publication manuelle (fait, 20 novembre 2026)

- **Activation** : sur la page « Comptes », le titulaire ou un administrateur passe un compte en publication manuelle, et peut revenir à la publication automatique.
- **Au créneau** : le post validé est envoyé par e-mail au titulaire, avec le texte à copier et les images en pièces jointes. Une notification apparaît aussi dans l'application. Aucun appel à LinkedIn n'est fait.
- **Connexion LinkedIn** : pas nécessaire. Ce mode sert donc aussi quand une connexion a expiré, ou pour un compte qui ne peut pas être relié à l'API.
- **Statut du post** : il passe « publié », avec la mention « envoyé pour publication manuelle ». Le titulaire peut ensuite y coller le lien du post LinkedIn, pour le suivi.

## SUI-03 à SUI-05 : statistiques, enseignements, rapport mensuel (fait, 20 novembre 2026)

- **Statistiques LinkedIn (SUI-03)** : relevées à J+1, J+7 et J+30 après la publication, avec 5 jours de rattrapage, toutes les 6 heures :
  - impressions, réactions, commentaires et partages des posts ;
  - abonnés des pages, une fois par jour.

  Si LinkedIn ne donne pas une statistique, elle est notée « indisponible ». Les permissions nécessaires relèvent de la Community Management API : `r_organization_social` pour les pages, `r_member_postAnalytics` pour les profils. Rien n'est estimé.
- **Enseignements (SUI-04)** : au plus 3 constats par mois. Ils sont calculés sur des posts réels, pas rédigés par l'IA :
  - avec ou sans visuel ;
  - longueur ;
  - origine des sujets ;
  - motif de refus le plus fréquent.

  Un constat n'est fait qu'avec au moins 2 posts mesurés de chaque côté et un écart net. Ils sont enregistrés en début de mois, affichés au tableau de bord et transmis à la rédaction du mois suivant, dans le contexte de chaque compte.
- **Rapport mensuel PDF (SUI-05)** : à télécharger depuis le tableau de bord, pour le mois en cours ou le mois précédent. Il contient :
  - les chiffres du mois ;
  - les posts par compte ;
  - les 3 posts les plus engageants ;
  - l'évolution des abonnés ;
  - les enseignements ;
  - les motifs de refus.

  Envoi automatique facultatif, en début de mois, aux administrateurs, aux responsables de la communication et aux propriétaires.

**Mode simulé** : avec `LINKEDIN_MODE=fake`, des statistiques simulées, stables pour un même post, alimentent le tableau de bord et le rapport.

## ONB-05 et ONB-09 : charte depuis le site, import de planning dans l'assistant (fait, 20 novembre 2026)

- **Charte proposée à partir du site (ONB-05)** : sur la page « Visuels », bouton « Proposer la charte ». La lecture du site est protégée comme celle des flux RSS. L'outil cherche trois choses :
  - **couleurs** : balise theme-color, variables CSS de marque, puis couleurs les plus fréquentes. Les gris sont écartés et la couleur principale est assombrie si un texte blanc n'y serait pas lisible ;
  - **police des titres** : rapprochée d'Inter, de Montserrat ou de Lora ;
  - **logo** : image marquée « logo », sinon icône Apple, sinon image de partage. Il est gardé dans la médiathèque sous l'étiquette « Logo du site ».

  Le formulaire est pré-rempli. Rien n'est enregistré avant « Enregistrer la charte ».
- **Import de planning dans l'assistant (ONB-09)** : l'assistant de démarrage propose, en facultatif, d'importer un planning existant. L'import accepte maintenant, en plus du fichier CSV, l'adresse d'une **feuille Google Sheets partagée par lien** : l'onglet ouvert est lu en CSV. Depuis l'assistant, on y revient après l'import.

## SIT-01 à SIT-08 : site vitrine (fait, 20 novembre 2026)

- **Page unique à la racine (SIT-01)** : pour les visiteurs non connectés ; les personnes connectées arrivent sur « Mes posts », à la même adresse. Elle présente :
  - la promesse ;
  - « Comment ça marche » en 4 étapes ;
  - les fonctionnalités ;
  - « Pour qui » (PME et ETI, agences) ;
  - les tarifs, lus dans les formules en base ;
  - les questions fréquentes ;
  - les appels à l'action.

  Rendu serveur, sans JavaScript, sans cookie ni police téléchargée, pour la rapidité (SIT-07).
- **Essai gratuit et démonstration (SIT-02)** : le bouton « Essai gratuit » mène à l'inscription. Le formulaire « Demander une démonstration » (nom, entreprise, e-mail, téléphone, nombre de comptes) :
  - est enregistré et envoyé par e-mail à `SALES_EMAIL` ;
  - est transmis au CRM si `DEMO_WEBHOOK_URL` est défini (POST JSON, en-tête `X-Demo-Secret`) ;
  - est protégé par un champ piège et limité à 5 demandes par heure et par adresse IP ;
  - est listé dans le back-office (« Site et démos »).
- **Simulateur de prix (SIT-03)** : nombre de profils et de pages, puis prix mensuel, équivalent en annuel et posts rédigés inclus, pour chaque formule. Il fonctionne sans JavaScript.
- **Pages légales (SIT-04)** : mentions légales, conditions d'utilisation, conditions de vente, confidentialité, cookies, sous-traitants. Ce sont des **projets**, à relire par un juriste. Les informations propres à SimplX sont marquées « À compléter » : raison sociale, SIREN, adresse, hébergeur, durées, responsabilité. L'inscription renvoie aux conditions.
- **Cookies (SIT-05)** : seuls des cookies strictement nécessaires, exemptés de consentement. Il n'y a donc pas de bandeau, comme le prévoit la section 9 du cahier. La page « Cookies » les liste.
- **Référencement (SIT-06)** : titre et description, données structurées (Organization, SoftwareApplication avec les offres, FAQPage), `sitemap.xml`, `robots.txt` (l'application et l'API exclues), `llms.txt`.
- **Témoignage (SIT-08)** : saisi dans le back-office avec la date de l'accord écrit du client, et affiché seulement s'il existe. Aucun témoignage n'est inventé.

**À faire par SimplX** :

- compléter et faire valider les pages légales ;
- obtenir l'accord écrit de Secutop et saisir le témoignage ;
- définir `SALES_EMAIL`, et `DEMO_WEBHOOK_URL` si les demandes doivent aller au CRM ;
- mesurer le score Lighthouse sur le domaine définitif.

## VIS-06 : avatar de marque (fait, 20 novembre 2026)

- **Déclaration** : sur la fiche de son compte (profil personnel), le **titulaire lui-même** déclare un avatar, une image générée qui le représente. Il accepte un texte de consentement versionné, enregistré avec la date et l'adresse IP.
- **Usage** : quand un visuel de ce compte doit porter une image générée, l'avatar la remplace. Une photo de la médiathèque qui convient reste préférée. L'avatar porte la mention « image générée par IA ».
- **Cloisonnement** : l'avatar n'entre pas dans la médiathèque de l'espace. Il ne sert donc jamais sur les posts d'un autre compte.
- **Retrait** : le titulaire ou un administrateur le retire à tout moment ; les nouveaux visuels ne l'utilisent plus. Déclaration et retrait sont inscrits au journal d'audit.

## VIS-07 : connecteur Canva (fait, 20 novembre 2026)

- **Connexion** : sur la page « Visuels », bouton « Connecter Canva ». L'autorisation passe par OAuth 2 avec PKCE et l'état est vérifié au retour. Les jetons sont chiffrés et renouvelés avant leur échéance. Seul qui gère le contenu de l'espace peut connecter Canva.
- **Modèles de marque** : la page liste les modèles de marque du Canva du client. « Ajouter » relie leurs champs aux zones du visuel d'après leur nom (titre, sous-titre, points, signature, photo) et range le modèle parmi les modèles de l'espace.
- **Pour chaque post** : si le modèle choisi est un modèle Canva, une copie est remplie dans le Canva du client (la photo est d'abord envoyée dans ses fichiers), puis exportée en PNG comme visuel. **Les designs restent dans le Canva du client.** Si Canva ne répond pas, le visuel est rendu localement avec une mise en page de secours, et une note le signale.
- **Mode simulé** : `CANVA_MODE=fake`.

**À faire par SimplX** : créer l'intégration dans le portail développeurs Canva, avec l'adresse de retour `https://<domaine>/visuels/canva/retour` et les autorisations `design:content:read/write`, `design:meta:read`, `asset:write`, `brandtemplate:meta:read` et `brandtemplate:content:read`. La faire valider par Canva, puis définir `CANVA_CLIENT_ID` et `CANVA_CLIENT_SECRET`, pour le serveur web et pour les tâches de fond. Les modèles de marque et le remplissage automatique demandent un abonnement Canva qui les propose.

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

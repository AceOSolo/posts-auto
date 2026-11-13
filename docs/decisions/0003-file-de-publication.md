# 0003 – File de publication et garantie d'unicité

13 novembre 2026 · statut : adopté

## Contexte

PUB-03 exige qu'un post ne soit publié qu'une fois, « même en cas de panne ou de relance ». Or l'API Posts de LinkedIn n'accepte pas de clé d'unicité. Et sur un profil personnel, on ne peut pas vérifier après coup si un post existe : la permission de lecture `r_member_social` est fermée par LinkedIn.

## Décisions

1. **Le post est sa propre entrée de file**, sans gestionnaire de file séparé. Une tâche passe toutes les minutes (section 8.4). Un post « validé » dont l'heure est atteinte passe « en_publication » avec une prochaine tentative ; les colonnes `publish_retries_left`, `next_publish_attempt_at` et `publish_lease_until` (migration 007) portent l'état de la file. pg-boss n'est pas utilisé ici : la file vit déjà dans la table des posts, dans les mêmes transactions que les changements de statut.
2. **Deux verrous empêchent qu'un post soit pris par deux processus** :
   - un verrou de ligne (`FOR UPDATE SKIP LOCKED`) au moment de réserver le post ;
   - un verrou à durée limitée (15 minutes, plus que le pire envoi : 9 images et le post, à 30 s par appel).
   Chaque tentative est enregistrée dans `publish_attempts` **avant** l'appel à LinkedIn, avec une clé `post:numéro`. Un index unique interdit deux tentatives en cours sur le même post.
3. **Chaque échec est classé selon que le post a pu être créé ou non** (`@posts-auto/linkedin`, `errors.ts`) :
   - `not_created` : échec pendant l'envoi des images, connexion jamais établie, réponses 4xx, 429 ou 503. Une nouvelle tentative est sans danger ; elle est faite à 1, 5 puis 15 minutes pour 429, 409, 503 et les erreurs réseau.
   - `unknown` : coupure après l'envoi, délai dépassé, réponses 500, 502 ou 504, processus arrêté pendant l'envoi (verrou expiré avec une tentative non terminée). **Aucune nouvelle tentative automatique** : le post passe en « erreur » avec le message « vérifiez sur LinkedIn avant de réessayer », et le titulaire, les administrateurs et le propriétaire sont alertés.
4. **Conditions de départ vérifiées au démarrage** :
   - abonnement actif (FAC-06), espace actif et compte connecté (RÈG-22) ; sinon le post reste validé ;
   - aucun marqueur bloquant (RÈG-05) ; sinon retour « à valider » ;
   - événement non passé (RÈG-11) ; sinon abandon ;
   - un post en retard de plus de 15 minutes suit RÈG-06 : départ immédiat ou nouveau créneau.
5. **Le texte est échappé au format « little »** de LinkedIn (caractères réservés `| { } @ [ ] ( ) < > # \ * _ ~`). Sans cela, une parenthèse ou une liste à puces peut fausser le post.
6. **Jetons chiffrés en AES-256-GCM** avec une clé hors base, rotation possible. Chaque chiffré est lié à son compte (données authentifiées) : un jeton copié sur un autre compte est illisible.
7. **Un faux LinkedIn** (`FakeLinkedIn`) simule les pannes, dont la pire : le post est créé mais la réponse se perd. Les tests de la file tournent sur une vraie base, avec une horloge contrôlée.

## Reste à faire

- Branchement réel : identifiants de l'application LinkedIn A (à créer par SimplX), test de publication à plusieurs images sur un profil (point L10 du cadrage).
- Pour les pages, avec la Community Management API : lever l'incertitude en relisant les posts récents de la page (`r_organization_social`) avant de conclure à une erreur.
- Envoi effectif des notifications par e-mail (Brevo) : les lignes `notifications` sont déjà créées.
- Bouton « réessayer » et retour « à valider » côté application (commandes `retry` et `backToReview` du moteur).
- Conversion des images WebP en PNG ou JPEG à l'envoi dans l'outil.

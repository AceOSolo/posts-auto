# posts-auto

SaaS de posts LinkedIn rédigés par IA, validés par chaque titulaire et publiés automatiquement au bon créneau. Client pilote : Secutop. Produit porté et développé par SimplX.

## Documents

- [Cahier des charges v1.1](./Cahier%20des%20charges%20–%20SaaS%20de%20posts%20LinkedIn%20assistés%20par%20IA.md) : la référence fonctionnelle.
- [Revue du cadrage](./docs/cadrage/01-revue-cdc-v1.md) : règles LinkedIn vérifiées, contradictions corrigées, décisions.
- [Décisions techniques](./docs/decisions/) : un fichier par décision.
- [Avancement de l'incrément 1a](./docs/avancement-1a.md) : critères de recette, preuves, ce qui reste à brancher.
- [Avancement de l'incrément 1b](./docs/avancement-1b.md) : planning, rédaction par l'IA, reprises ; ce qui reste à brancher.
- [Avancement de l'incrément 1c](./docs/avancement-1c.md) : visuels (modèles, médiathèque, images générées) ; ce qui reste à brancher.
- [Avancement de l'incrément 2a](./docs/avancement-2a.md) : inscription en libre-service, essai gratuit, assistant de démarrage.
- [Avancement de l'incrément 2b](./docs/avancement-2b.md) : abonnement Stripe, quotas mensuels, packs, impayés, export des usages, espaces des agences.
- [Avancement de l'incrément 2c](./docs/avancement-2c.md) : double authentification (TOTP), connexion Google et Microsoft.
- [Avancement de l'incrément 2d](./docs/avancement-2d.md) : back-office de l'éditeur (organisations, supervision, paramètres, galerie, annonces, support).
- [Avancement de l'incrément 2e](./docs/avancement-2e.md) : fonctions complémentaires du lot 2 (publication manuelle, statistiques, rapports, connecteurs…).
- [Après le lot 2](./docs/avancement-3.md) : mise en production, tests dans le navigateur, améliorations (meilleurs moments, post d'exemple, Slack et Teams, déclinaison d'articles) et ce qui reste à faire de votre côté.
- [Mise en production](./docs/deploiement.md) et [recette des intégrations](./docs/recette-integrations.md).
- [API d'échange](./docs/api-echange.md) : comment la tâche Claude actuelle dépose ses posts et lit les décisions (incrément 1a), et comment reprendre ses idées et ses demandes (incrément 1b).

## Structure

| Dossier | Contenu |
| --- | --- |
| `packages/core` | Règles métier pures : cycle de vie d'un post, marqueurs bloquants, phrase de départ, calendrier de l'espace (fuseau, plages, jours fériés), créneaux, replanification, règles de rédaction mesurables, affectation des sujets aux créneaux, lecture des CSV du planning. Sans base de données ni réseau. |
| `packages/db` | Base PostgreSQL : migrations SQL, cloisonnement des clients par la base (RLS), accès typé avec Kysely, contextes `asUser` / `asSystem`. |
| `packages/ai` | Rédaction par l'IA : modèle Anthropic ou simulé, consignes versionnées, rédaction puis vérification indépendante, garde contre les consignes cachées, coût des appels. |
| `packages/visuals` | Visuels : modèles à zones nommées, rendu PNG côté serveur (Skia, police Inter embarquée), contrôle de lisibilité, modèles de départ, alternance photo / texte, générateurs d'images (simulé, Higgsfield). |
| `packages/linkedin` | Client de l'API LinkedIn (posts, images, format « little »), classification des pannes (post créé ou non), faux LinkedIn pour les tests. |
| `packages/services` | Actions et lectures appelées par l'application : connexion, validation, corrections, créneaux, « Mes posts », vue équipe, avec contrôle des droits. |
| `packages/worker` | Tâches de fond : publication, replanification, connexions, rappels, e-mails, rédaction hebdomadaire (avec les visuels), demandes, reprises, visuels à refaire, veille RSS, apprentissage ; chiffrement des jetons, stockage des médias. |
| `apps/web` | Application web Next.js : connexion, « Mes posts », détail et décision, vue équipe, comptes et fiches, ligne éditoriale, planning, idées et demandes, rédaction, visuels (modèles, éditeur, charte, médiathèque), API d'échange. |

## Démarrer

Prérequis : Node.js 24 ou plus, Docker.

```sh
npm install
docker compose up -d --wait        # PostgreSQL 16 sur 127.0.0.1:15432
npm run migrate -w @posts-auto/db  # applique les migrations à la base de développement
npm run seed -w @posts-auto/web    # données de démonstration (espace « Démo Secutop »)
npm run dev -w @posts-auto/web     # http://localhost:3000
npm run start -w @posts-auto/worker  # tâches de fond : publication, rédaction, reprises, demandes, rappels, e-mails…
```

En développement :
- `LINKEDIN_MODE=fake` simule LinkedIn (connexion et publication) ;
- `AI_MODE=fake` simule l'IA, avec des textes de démonstration marqués comme tels. Ce réglage est obligatoire pour simuler : sans lui ni clé Anthropic, la rédaction reste à l'arrêt ;
- `IMAGE_MODE=fake` simule le générateur d'images ; sans ce réglage, aucune image n'est générée et les visuels prennent une photo de la médiathèque ou sont des visuels texte.

Les tâches de fond exigent `TOKEN_ENCRYPTION_KEYS` et `TOKEN_ENCRYPTION_KEY_ID` (voir `.env.example`).

Connexion : saisir `jp@demo.example.test` (titulaire), `alexis@…` (communication, déléguée sur la page), `claire@…` (formatrice) ou `direction@…` (lecture seule). Le lien de connexion s'affiche dans la console du serveur.

Variables d'environnement (voir `.env.example`) : `DATABASE_URL`, `APP_URL`, `MEDIA_ROOT`, `TOKEN_ENCRYPTION_KEYS`, `TOKEN_ENCRYPTION_KEY_ID`, `AI_MODE`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_USD_TO_EUR`, `SUPPORT_EMAIL`, `IMAGE_MODE`, `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET`, `HIGGSFIELD_MODEL`, `HIGGSFIELD_COST_USD`.

## Commandes

Sous Windows, lancer les tests depuis PowerShell : sous Git Bash, la casse du chemin (`C:` au lieu de `c:`) fait échouer Vitest.

```sh
npm test                                       # tous les tests (ceux de la base exigent Docker)
npm run typecheck                              # vérification des types
npm run test:coverage                          # tests et couverture (seuil : 80 %)
npm run check                                  # types puis tests
npm run codegen -w @posts-auto/db              # régénère les types de la base après une migration
npm run codegen -w @posts-auto/db -- --verify  # vérifie que les types sont à jour
npm run build -w @posts-auto/web               # compile l'application
npm run smoke -w @posts-auto/web               # test de fumée de l'application lancée (après seed)
npm run e2e -w @posts-auto/web                 # tests dans le navigateur, ordinateur et téléphone (après seed, APP_URL)
npm run api-key -w @posts-auto/web -- --espace <uuid> --nom "Tâche Claude"  # clé de l'API d'échange
```

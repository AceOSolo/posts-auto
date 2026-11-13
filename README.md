# posts-auto

SaaS de posts LinkedIn rédigés par IA, validés par chaque titulaire et publiés automatiquement au bon créneau. Client pilote : Secutop. Produit porté et développé par SimplX.

## Documents

- [Cahier des charges v1.1](./Cahier%20des%20charges%20–%20SaaS%20de%20posts%20LinkedIn%20assistés%20par%20IA.md) : la référence fonctionnelle.
- [Revue du cadrage](./docs/cadrage/01-revue-cdc-v1.md) : règles LinkedIn vérifiées, contradictions corrigées, décisions.
- [Décisions techniques](./docs/decisions/) : un fichier par décision.
- [Avancement de l'incrément 1a](./docs/avancement-1a.md) : critères de recette, preuves, ce qui reste à brancher.
- [API d'échange](./docs/api-echange.md) : comment la tâche Claude actuelle dépose ses posts et lit les décisions (incrément 1a).

## Structure

| Dossier | Contenu |
| --- | --- |
| `packages/core` | Règles métier pures : cycle de vie d'un post, marqueurs bloquants, phrase de départ, calendrier de l'espace (fuseau, plages, jours fériés), créneaux, replanification. Sans base de données ni réseau. |
| `packages/db` | Base PostgreSQL : migrations SQL, cloisonnement des clients par la base (RLS), accès typé avec Kysely, contextes `asUser` / `asSystem`. |
| `packages/linkedin` | Client de l'API LinkedIn (posts, images, format « little »), classification des pannes (post créé ou non), faux LinkedIn pour les tests. |
| `packages/services` | Actions et lectures appelées par l'application : connexion, validation, corrections, créneaux, « Mes posts », vue équipe, avec contrôle des droits. |
| `packages/worker` | Tâches de fond : file de publication, replanification, chiffrement des jetons, stockage des médias. |
| `apps/web` | Application web Next.js : connexion, « Mes posts », détail et décision, vue équipe. |

## Démarrer

Prérequis : Node.js 24 ou plus, Docker.

```sh
npm install
docker compose up -d --wait        # PostgreSQL 16 sur 127.0.0.1:15432
npm run migrate -w @posts-auto/db  # applique les migrations à la base de développement
npm run seed -w @posts-auto/web    # données de démonstration (espace « Démo Secutop »)
npm run dev -w @posts-auto/web     # http://localhost:3000
npm run start -w @posts-auto/worker  # tâches de fond : publication, replanification, connexions, rappels, e-mails
```

En développement, `LINKEDIN_MODE=fake` simule LinkedIn (connexion et publication) ; les tâches de fond exigent `TOKEN_ENCRYPTION_KEYS` et `TOKEN_ENCRYPTION_KEY_ID` (voir `.env.example`).

Connexion : saisir `jp@demo.example.test` (titulaire), `alexis@…` (communication, déléguée sur la page), `claire@…` (formatrice) ou `direction@…` (lecture seule). Le lien de connexion s'affiche dans la console du serveur.

Variables d'environnement (voir `.env.example`) : `DATABASE_URL`, `APP_URL`, `MEDIA_ROOT`, `TOKEN_ENCRYPTION_KEYS`, `TOKEN_ENCRYPTION_KEY_ID`.

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
npm run api-key -w @posts-auto/web -- --espace <uuid> --nom "Tâche Claude"  # clé de l'API d'échange
```

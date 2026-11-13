# 0002 – Base de données : migrations SQL, Kysely, cloisonnement par la base

13 novembre 2026 · statut : adopté · remplace le choix « Drizzle » prévu dans 0001

## Contexte

Le schéma du cahier des charges (section 7) s'appuie sur des fonctions propres à PostgreSQL : sécurité au niveau des lignes (RLS), index uniques partiels, contraintes reportables, colonnes calculées, `NULLS NOT DISTINCT`. Le cloisonnement des clients (SEC-01) est l'exigence de sécurité la plus importante du produit.

## Décisions

1. **Les migrations sont des fichiers SQL écrits à la main** (`packages/db/migrations/NNN_nom.sql`). Ils sont appliqués dans l'ordre, chacun dans sa transaction, par le migrateur de Kysely ; le suivi est rangé dans le schéma `migrations`. Une migration appliquée ne se modifie plus.
   *Pourquoi pas Drizzle* : il aurait fallu décrire le schéma une seconde fois en TypeScript et confier la génération de la RLS à l'outil. Pour la partie la plus sensible du produit, on veut un SQL lu et relu tel qu'il s'exécute.
2. **Requêtes typées avec Kysely ; types générés depuis la base** (`npm run codegen -w @posts-auto/db`). Les migrations sont la seule source de vérité. `--verify` échoue si les types ne sont plus à jour (à brancher dans l'intégration continue). Les types sont affinés à la main dans `schema.ts` quand une contrainte porte un sens métier (statuts des posts), et un test vérifie la concordance avec `@posts-auto/core`.
   *Note* : kysely-codegen 0.20 utilise l'API JavaScript de TypeScript, absente de TypeScript 7 ; ses options de types personnalisés ne fonctionnent donc pas. D'où l'affinage dans `schema.ts`.
3. **Deux rôles applicatifs** :
   - `app_web` (application et API) est soumis à la RLS ;
   - `app_worker` (tâches de fond) la traverse.

   Chaque transaction fixe son contexte : `asUser(db, userId, …)` pose `app.user_id` et passe en `app_web` ; `asSystem(db, …)` passe en `app_worker`. En production, chaque processus se connecte avec un compte membre du seul rôle dont il a besoin.
4. **La RLS assure l'isolation, l'application assure les droits fins.** La base garantit qu'un utilisateur ne lit ni n'écrit hors de ses espaces ; les rôles éditeur, contributeur et titulaire sont vérifiés par l'application. Les deux couches sont nécessaires.
5. **Clés étrangères composites `(…_id, workspace_id)` sur toutes les tables enfants.** La RLS ne contrôle que la ligne écrite : sans ces clés, un utilisateur pourrait rattacher une ligne de son espace au post d'un autre client. Même principe pour le journal d'audit : `(workspace_id, org_id)`.
6. **Tables réservées au système** : jetons LinkedIn, liens de validation, liens de connexion, sessions. `app_web` n'y a aucun droit ; seul du code serveur de confiance y accède.
7. **Tests sur une vraie base PostgreSQL 16** (Docker). Chaque exécution crée une base jetable, la migre et la supprime. Une contre-épreuve a confirmé que les tests d'isolation échouent quand la RLS est désactivée.

## Ajouts au schéma de la v1.1 du cahier

| Ajout | Raison |
| --- | --- |
| `posts.must_publish_by` | RÈG-11 : date limite d'un post lié à un événement |
| `workspaces.slot_step_minutes`, `max_posts_per_account_per_day`, `min_gap_minutes`, `max_posts_per_slot` | RÈG-02, PUB-06 et RÈG-08 « réglables par espace » |
| `post_versions.revision` | Numéro de révision du texte (distinct du numéro de reprise `posts.version_no`) |
| Tables `login_tokens`, `sessions` | Connexion par lien e-mail et sessions révocables (ONB-01, SEC-03), absentes du schéma |
| Limites : 3 000 caractères par texte, 9 images par post, 10 Mo par image | Limites de LinkedIn et SEC-07, garanties par la base |

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

## Incrément 1b (migrations 011 à 013)

| Écart ou ajout | Raison |
| --- | --- |
| Fonction `app.protect_workspace_table` | Toute table créée après 006 reçoit la même protection (RLS, droits, règle d'isolation). Un test vérifie que **toutes** les tables ont la RLS activée |
| `planning_cells` : une ligne par sujet, avec `position` | Une case du planning peut contenir plusieurs sujets (PLA-02) ; chaque sujet a son post et son état |
| État d'une case calculé, sauf « mis de côté » (`set_aside_at`, `set_aside_reason`) | L'état (prévu, rédigé, validé, publié) découle des posts : le stocker créerait des incohérences |
| `offer_items.status` et `offer_items.pricing` séparés | La v1.1 mélangeait disponibilité et prix dans une seule liste |
| Tables de liaison `event_accounts`, `idea_accounts`, `request_accounts`, `request_photos` | Remplacent les listes `uuid[]`, comme le prévoyait la section 7 |
| `ideas.event_on`, `ideas.from_post_id` ; pas de `ideas.post_id` | Date d'événement d'IDE-01 ; post d'origine d'un sujet mis en réserve (IDE-02). Le post issu d'une idée se lit par `posts.idea_id` |
| `posts.event_id` | Événement relayé par le post (PLA-04) |
| `post_requests.attempts`, `lease_until`, `last_error`, `processed_at` | Traitement des demandes dans l'heure (IDE-06), avec reprise après interruption |
| `generation_runs.lease_until`, `triggered_by`, `error` | Une génération à la fois par espace, reprise après interruption (décision 0005) |
| `ai_usage` : jetons par catégorie, coût en dollars et en euros, objet de l'appel | Mesure du coût réel (GEN-11) ; le fournisseur facture en dollars |
| `content_reports` | « Signaler un contenu » (GEN-12) |
| Photos d'une demande : 9 au plus | Maximum d'images d'un post (VIS-09) ; IDE-03 corrigé |

## Incrément 1c (migrations 018 et 019)

| Écart ou ajout | Raison |
| --- | --- |
| Pas de table `template_zones` : zones dans `templates.definition` | Un modèle est toujours édité et rendu en entier ; la définition est validée par `@posts-auto/visuals` (décision 0006) |
| `templates.has_photo` (colonne calculée), `gallery_key`, `archived_at` ; pas de `is_global` | Alternance photo / texte (VIS-04) ; copie unique de chaque modèle de départ par espace ; un modèle cité par des visuels n'est pas supprimé. La galerie de départ est dans le code, copiée dans chaque espace |
| `media_assets.in_library`, `label`, `folder`, `uploaded_by` | Médiathèque (VIS-08) : seules des photos y entrent, jamais un visuel rendu |
| `media_assets.source_asset_id`, `render_content`, clé étrangère `template_id` | Recette d'un visuel rendu (modèle, textes, photo), pour le refaire (VIS-13) |
| Table `visual_tasks` (`photo_mode` : garder, changer, sans photo) | « Refaire le visuel », traité par le worker avec bail et essais |
| `workspaces.image_budget_monthly` | Budget d'images générées par mois (VIS-05) |
| `ai_usage.purpose = 'visual'` | Remplissage d'un modèle par l'IA, compté à part (GEN-11) |

## Lot 2, incrément 2a (migrations 020 et 021)

| Écart ou ajout | Raison |
| --- | --- |
| Table `signup_requests`, réservée au système comme `login_tokens` | Inscription en libre-service (ONB-01) : rien n'est créé avant la confirmation de l'adresse |
| `workspaces.company_size`, `workspaces.onboarding_done_at` | Assistant de démarrage (ONB-03, étape 1) ; l'avancement est calculé, seule la fermeture est enregistrée |
| Espaces existants marqués « démarrés » | Ils ont été mis en place à la main (Secutop) |
| Essai : `organizations.trial_ends_at` (existant) sans `stripe_customer_id` | ONB-06 ; pas de nouvelle colonne |

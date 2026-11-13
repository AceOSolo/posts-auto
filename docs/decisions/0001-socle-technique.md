# 0001 – Socle technique et moteur de règles

13 novembre 2026 · statut : adopté

## Contexte

Le cahier des charges (section 8.1) fixe TypeScript de bout en bout et PostgreSQL, et laisse plusieurs choix « à confirmer par SimplX ». SimplX développe le produit ; ce document consigne les choix faits au démarrage de l'incrément 1a, et pourquoi. Chaque choix peut être revu : il suffit d'ajouter une décision qui remplace celle-ci.

## Décisions

1. **Monorepo avec les espaces de travail npm** (`packages/*`, puis `apps/*`). pnpm aurait été possible, mais il demande une installation globale, parfois avec des droits administrateur sous Windows ; npm suffit à ce stade et le passage à pnpm ne touchera pas au code.
2. **Node.js 24 ou plus (version LTS) et TypeScript 7 en mode strict**, avec `noUncheckedIndexedAccess` et `exactOptionalPropertyTypes`, et des modules ES.
3. **Un paquet de règles métier pures : `@posts-auto/core`.** Il contient le cycle de vie des posts (6.1), le calendrier de l'espace, l'occupation des créneaux et la replanification (6.2 à 6.5). Il n'accède ni à la base, ni au réseau, ni à l'horloge : on lui passe l'instant présent. L'application web, l'API d'échange (PUB-10) et les tâches de fond l'appellent tous. Les règles sont donc écrites une seule fois et testées sans infrastructure.
4. **Dates : Luxon pour les fuseaux et l'heure d'été.** Les heures « métier » (créneau habituel du mardi à 12h00, plage de 8h00 à 18h00) sont exprimées en heure locale de l'espace ; les instants sont des `Date` en UTC. Les tests tournent volontairement dans le fuseau `America/New_York`, pour prouver que le code ne dépend pas du fuseau de la machine.
5. **Tests : Vitest, avec un seuil de couverture de 80 %** (exigence NF-12), qui fait échouer la suite s'il n'est plus atteint.

## Choix prévus pour les étapes suivantes (à confirmer au moment de les mettre en place)

| Sujet | Choix prévu | Raison |
| --- | --- | --- |
| Base de données | PostgreSQL 16, dans Docker en local | Version stable qui couvre tout ce qu'exige le schéma de la section 7 (`NULLS NOT DISTINCT`, index partiels, RLS) |
| Accès aux données et migrations | Drizzle | SQL explicite : RLS, index partiels et contraintes reportables restent lisibles ; pas de moteur binaire à déployer |
| File de tâches | pg-boss | La file vit dans PostgreSQL : une brique de moins à exploiter, et le changement de statut d'un post peut être enregistré dans la même transaction que la tâche de publication, ce qui protège l'unicité de publication (PUB-03) |
| Application web | Next.js (App Router) | Recommandation de la section 8.1 : rendu serveur pour la one-page, application mobile installable (PWA) |

## Conventions

- Les identifiants de code sont en anglais. Les valeurs métier (statuts, motifs) restent en français, comme dans le schéma SQL du cahier (`a_valider`, `trop_de_replanifications`). Les commentaires et les messages sont en français.
- Le code cite les codes du cahier (RÈG-08, VAL-03…) aux endroits qui les appliquent ; une règle du cahier découverte ambiguë ou incohérente pendant le développement est tranchée, puis corrigée dans le cahier.

# posts-auto

SaaS de posts LinkedIn rédigés par IA, validés par chaque titulaire et publiés automatiquement au bon créneau. Client pilote : Secutop. Produit porté et développé par SimplX.

## Documents

- [Cahier des charges v1.1](./Cahier%20des%20charges%20–%20SaaS%20de%20posts%20LinkedIn%20assistés%20par%20IA.md) : la référence fonctionnelle.
- [Revue du cadrage](./docs/cadrage/01-revue-cdc-v1.md) : règles LinkedIn vérifiées, contradictions corrigées, décisions.
- [Décisions techniques](./docs/decisions/) : un fichier par décision.

## Structure

| Dossier | Contenu |
| --- | --- |
| `packages/core` | Règles métier pures : cycle de vie d'un post, calendrier de l'espace (fuseau, plages, jours fériés), occupation des créneaux, replanification. Sans base de données ni réseau. |

## Commandes

Prérequis : Node.js 24 ou plus.

```sh
npm install           # dépendances
npm test              # tests
npm run typecheck     # vérification des types
npm run test:coverage # tests et couverture (seuil : 80 %)
npm run check         # types puis tests
```

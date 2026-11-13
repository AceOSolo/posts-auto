# API d'échange (PUB-10)

Pendant l'incrément 1a, la tâche Claude programmée de Secutop continue de **rédiger** les posts. Elle les **dépose** dans l'application, qui se charge de la validation par les titulaires et de la publication sur LinkedIn. Cette API est le pont entre les deux. Elle servira ensuite de base à l'API publique (lot 3).

## En bref

1. Une **clé par espace**, à garder secrète.
2. La tâche **lit les comptes** pour connaître leurs identifiants.
3. Elle **dépose chaque post** avec une **référence** qu'elle choisit. Renvoyer la même référence ne crée jamais de doublon, ce qui permet de réessayer sans risque.
4. Elle **lit les posts et les décisions** des titulaires (validé, modification demandée avec sa note, refusé avec son motif).
5. Pour une **reprise**, elle dépose un nouveau post avec `remplace` : la référence de l'ancien. L'ancien passe « remplacé ».

L'application applique les mêmes règles que pour un post saisi à la main :
- un seul post par compte et par créneau ;
- 30 minutes entre deux posts de l'espace, et au plus 2 posts par compte et par jour ;
- 3 000 caractères au plus ;
- 9 images au plus, au format PNG, JPEG ou GIF, de 10 Mo chacune au plus, débarrassées de leurs métadonnées ;
- 3 reprises au plus.

## Clé d'API

En attendant l'écran d'administration, un administrateur de SimplX crée la clé :

```sh
npm run api-key -w @posts-auto/web -- --espace <identifiant de l'espace> --nom "Tâche Claude Secutop"
```

La clé, de la forme `pa_xxxxxxxx_…`, n'est affichée qu'une fois. Elle s'envoie dans chaque requête :

```
Authorization: Bearer pa_xxxxxxxx_…
```

Une clé donne accès à son espace et à lui seul. Elle se révoque à tout moment.

## Points d'accès

Adresse de base : `https://<domaine>/api/v1`. Toutes les dates sont au format ISO 8601 **avec fuseau**, par exemple `2026-11-17T12:00:00+01:00` ou `2026-11-17T11:00:00Z`.

### `GET /comptes` : comptes LinkedIn de l'espace

```json
{ "comptes": [ { "id": "4f1c…", "type": "profil", "nom": "Jean-Pierre Martin", "statut": "connected", "titulaire": "Jean-Pierre" } ] }
```

### `POST /posts` : déposer un post à valider

| Champ | Obligatoire | Description |
| --- | --- | --- |
| `reference` | oui | Identifiant choisi par la tâche, unique dans l'espace (1 à 100 caractères : lettres, chiffres, `_ . : -`). Conseil : `semaine-compte-numéro`, par exemple `2026-W47-jp-1`. |
| `compte` | oui | `id` d'un compte de `GET /comptes`. |
| `creneau` | oui | Date et heure de publication, à au moins 15 minutes d'ici. |
| `texte` | oui | Texte du post, 3 000 caractères au plus. Les marqueurs `[À COMPLÉTER : …]` et `[À VÉRIFIER]` sont acceptés : ils empêchent la validation tant qu'ils restent (GEN-04, VAL-03). |
| `origine` | non | `planning` (par défaut), `event`, `team_idea`, `ai_idea`, `ai_reserve`, `request`, `external_source` (GEN-06). |
| `note_source` | non | D'où vient le sujet (case du PAM, idée, article…), affiché au titulaire. |
| `date_limite` | non | Pour un post lié à un événement : il ne partira jamais après cette date (RÈG-11). |
| `remplace` | non | Référence du post remplacé (voir « Reprises »). |
| `images` | non | Liste ordonnée, la première étant la couverture : `{ "donnees_base64": "…", "type": "image/png", "texte_alternatif": "…", "generee_par_ia": true }`. |

Réponses :
- **201** : post créé, `{ "cree": true, "post": { … } }` ;
- **200** : référence déjà reçue, `{ "cree": false, "post": { … } }` avec le post existant, inchangé.

```sh
curl -X POST https://<domaine>/api/v1/posts \
  -H "Authorization: Bearer $CLE" -H "Content-Type: application/json" \
  -d '{"reference":"2026-W47-jp-1","compte":"4f1c…","creneau":"2026-11-17T12:00:00+01:00",
       "texte":"Le document unique, ce n’est pas un classeur qui dort dans un tiroir…",
       "origine":"planning","note_source":"PAM, semaine 47, ligne JP"}'
```

### `GET /posts?depuis=…&jusqua=…` : posts et décisions

Par défaut, la période va de 7 jours en arrière à 14 jours en avant. Elle ne peut pas dépasser 62 jours.

```json
{
  "posts": [
    {
      "reference": "2026-W47-jp-1",
      "id": "9b2e…",
      "compte": "4f1c…",
      "statut": "modif",
      "creneau": "2026-11-17T11:00:00.000Z",
      "creneau_initial": null,
      "replanifications": 0,
      "version": 1,
      "remplace": null,
      "texte": "…",
      "marqueurs_bloquants": false,
      "decision": { "par": "Jean-Pierre", "le": "2026-11-16T09:12:00.000Z", "delegation": false, "note": "Plus court, et citer le salon de mars" },
      "publie_le": null,
      "lien": null,
      "erreur": null
    }
  ]
}
```

Statuts possibles : `a_valider`, `valide`, `modif` (modification demandée, la note dit quoi changer), `refuse` (la note donne le motif), `en_publication`, `publie` (avec `lien`), `erreur`, `remplace`, `abandonne`.

### `GET /posts/{reference}` : un post

Même format qu'un élément de la liste.

## Reprises

| Situation | Ce que fait la tâche | Résultat |
| --- | --- | --- |
| Statut `modif` (GEN-07) | Rédige une nouvelle version qui applique `decision.note`, et la dépose avec `remplace` = la référence de l'ancienne. | Nouvelle version (`version` + 1), l'ancienne passe `remplace`. |
| Statut `refuse` (GEN-07) | Propose un autre sujet pour le même compte, en tenant compte du motif, avec `remplace`. | Idem. |
| Post `a_valider` à remplacer par un meilleur sujet (GEN-03) | Dépose le nouveau post avec `remplace`. Le sujet remplacé est à remettre en réserve. | Le nouveau post repart en version 1. |
| Post `valide`, `publie`… | Rien : un post validé n'est jamais modifié par la tâche. | Refus `not_replaceable` (409). |

Au-delà de 3 reprises (version 4), l'API refuse (`too_many_reworks`) et le post doit être traité à la main.

Pour garder le même créneau, renvoyer le même `creneau` : l'ancien post libère le sien. Une reprise demandée moins de 3 heures avant le créneau devrait viser un créneau plus tardif (RÈG-14).

## Erreurs

Format : `{ "erreur": { "code": "…", "message": "…" } }`. Les codes sont stables ; les messages sont en français et peuvent évoluer.

| HTTP | Codes | Que faire |
| --- | --- | --- |
| 400 | `json_invalide`, `creneau_invalide`, `origine_invalide`, `reference_manquant`, `compte_manquant`, `texte_manquant`, `images_invalides`, `date_invalide` | Corriger la requête. |
| 401 | `cle_invalide` | Vérifier la clé (révoquée ?). |
| 403 | `droit_insuffisant` | La clé n'a pas le droit d'écrire. |
| 404 | `introuvable` | Référence inconnue. |
| 409 | `same_account_same_slot`, `account_daily_cap`, `workspace_min_gap`, `workspace_slot_cap`, `not_replaceable`, `too_many_reworks` | Choisir un autre créneau, ou laisser le post à l'humain. |
| 413 | `requete_trop_grosse` | Requête de plus de 50 Mo : réduire les images. |
| 422 | `invalid_reference`, `empty_body`, `body_too_long`, `too_many_images`, `image_unsupported`, `image_type_mismatch`, `image_corrupted`, `image_too_large`, `unknown_account`, `unknown_replaced`, `replaced_other_account`, `too_soon`, `after_event`, `window_too_large` | Corriger le contenu. |
| 500 | `erreur_interne` | Réessayer plus tard avec la même référence : sans risque de doublon. |

## Exemple de cycle hebdomadaire (lundi 7h30)

1. `GET /comptes`.
2. `GET /posts` sur la semaine en cours et la suivante. Repérer les posts `modif` et `refuse` (à reprendre) et les créneaux déjà occupés.
3. Pour chaque reprise : `POST /posts` avec `remplace`.
4. Pour chaque nouveau sujet du PAM : `POST /posts` sur un créneau libre, avec une référence stable, par exemple `2026-W47-jp-1`. Relancer la tâche ne crée alors aucun doublon.
5. Toutes les heures : `GET /posts` pour traiter les nouvelles décisions (reprises) et reporter dans le PAM les posts publiés (`publie_le`, `lien`).

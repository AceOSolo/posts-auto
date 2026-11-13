# Revue critique du cahier des charges v1 (lot 0 – cadrage)

13 novembre 2026 · relecture du document « Cahier des charges – SaaS de posts LinkedIn assistés par IA » du 10 novembre 2026.

**Objet** : relire le cahier des charges avant tout chiffrage ou développement, vérifier ses hypothèses LinkedIn auprès des sources officielles, relever les contradictions et les manques, et lister les décisions à prendre. Chaque point porte un code (L = LinkedIn, C = contradiction, M = manque, P = planning) pour pouvoir y répondre point par point.

**Verdict d'ensemble** : le document est solide. Les exigences sont numérotées et testables, il est fidèle à la chaîne qui tourne aujourd'hui, et le cycle de vie d'un post comme le modèle de données sont déjà bien pensés. Trois sujets doivent néanmoins être repris avant de chiffrer : 1) les règles LinkedIn, plus contraignantes et parfois plus favorables que ce qu'écrit le document ; 2) une douzaine de contradictions internes ; 3) le lot 1, trop chargé pour 10 semaines et auquel il manque les visuels.

---

## 1. Ce que LinkedIn impose (vérifié le 13/11/2026 sur la documentation officielle)

### L1. Une seule application LinkedIn suffit à terme, pour les profils comme pour les pages

La Community Management API couvre aussi les profils personnels : ses cas d'usage « Profile Management », « Executive Management » et « Employee Advocacy » permettent de publier pour le compte d'un membre. Le produit « Share on LinkedIn » n'est donc utile qu'en attendant l'accord LinkedIn (plan B). La section 8.2 laisse croire que deux produits sont nécessaires en permanence.

### L2. Conditions d'éligibilité : l'entité juridique doit être choisie maintenant

LinkedIn exige :
- une organisation juridiquement enregistrée, avec un usage commercial ;
- une adresse e-mail professionnelle vérifiée (une adresse personnelle échoue) ;
- un site web, un domaine et une politique de confidentialité valides ;
- une application **validée par un super-administrateur de la page LinkedIn de cette même organisation** ;
- un nom d'application sans « Linked », « In » ni logo LinkedIn ou Microsoft.

L'application sera donc rattachée à une entité (Secutop, SimplX ou une nouvelle structure) et à sa page LinkedIn. Changer d'entité plus tard oblige à refaire toute la procédure. Cela tranche, au moins en partie, la question ouverte n° 4.

### L3. La demande doit partir d'une application neuve, ce qui impose une stratégie à deux applications

La demande d'accès doit être faite depuis une application neuve, sans aucun autre produit LinkedIn. En cas de refus, il faut créer une nouvelle application. D'après la FAQ LinkedIn, une fois l'accès obtenu, on peut ensuite demander à l'ajouter à une application existante en indiquant l'identifiant de celle qui a été validée.

**Proposition** :
- **Application A**, dite « principale » : « Sign In with OpenID Connect » + « Share on LinkedIn ». Elle est utilisée dès le début pour les profils.
- **Application B**, dite « de vérification » : elle sert uniquement à demander la Community Management API.
- Une fois l'accès Standard obtenu, on demande son ajout à l'application A. Les profils déjà connectés n'auront alors pas à se reconnecter.

À confirmer auprès du support développeurs LinkedIn. Conséquence sur le modèle de données : chaque jeton doit retenir l'application LinkedIn qui l'a émis.

### L4. Jetons de renouvellement : le risque « certain » du document est probablement surévalué

LinkedIn fournit des jetons de renouvellement (365 jours) à « tous les partenaires approuvés du Marketing Developer Platform ». Une fois la Community Management API obtenue, le produit devrait donc en bénéficier : la reconnexion manuelle tous les 60 jours ne concernerait plus que la phase transitoire. Le modèle de données le prévoit déjà (`refresh_token_enc`). Il faut l'écrire dans les exigences, car la recette technique de LinkedIn l'exige (CM-005, CM-006, voir L8).

### L5. La politique IA de LinkedIn concerne directement ce produit

La « Developer AI Policy » de LinkedIn demande :

1. **De limiter la publication automatique de contenus générés par IA sans implication de l'utilisateur** (« without end user involvement »). Si le contenu est attribué à l'utilisateur, celui-ci doit d'abord pouvoir le modifier. La validation par le titulaire va dans ce sens. **En revanche, la délégation de validation sur un profil personnel est en tension directe avec cette règle** : un post IA part au nom de JP sans que JP l'ait vu.
2. **De la transparence** : signaler clairement que l'outil utilise l'IA (mention bien visible du type « propulsé par l'IA »), expliquer son fonctionnement, prévenir que les textes peuvent contenir des erreurs à vérifier, et offrir un moyen de signaler un contenu inapproprié.
3. **Un contrat écrit avec le fournisseur d'IA**, au moins aussi protecteur que la politique de LinkedIn pour les données venant de LinkedIn.
4. **Des données LinkedIn obtenues par l'API qui ne peuvent pas servir d'entrée à l'IA**, sauf les posts des utilisateurs de l'application qui y ont consenti. Conséquences :
   - SUI-04 (enseignements tirés des statistiques) et EDI-06 (apprentissage) exigent un consentement explicite ;
   - les commentaires d'autres membres ne doivent jamais être envoyés à l'IA ;
   - les posts collés à la main par le client (ONB-04, EDI-05) ne sont pas concernés.

### L6. Durées de conservation imposées

Ces règles portent sur les données **récupérées par l'API**. Elles ne visent pas les textes et images que le client produit dans l'outil (« data independently provided by your clients »).

| Donnée récupérée | Durée max |
| --- | --- |
| Identifiant et profil de base d'un membre qui s'est connecté à l'outil | Sans limite |
| Activité sociale des membres (posts, commentaires, réactions) | 48 h |
| Profil d'autres membres (ex. auteurs de commentaires) | 24 h en cache, jamais stockés |
| Activité des pages qui se sont connectées à l'outil | 6 mois |
| Statistiques d'administration d'une page (abonnés, synthèses) | 1 an |

**Conséquence** : les statistiques à J+30 des posts de **profils personnels** (SUI-03) relèvent probablement de la limite de 48 h. Il faut le clarifier avant de promettre des statistiques par profil. Pour les pages, conserver un an ne pose pas de problème.

### L7. Interdiction d'exporter les données des membres, y compris vers ses propres clients

LinkedIn interdit d'exporter ou de transférer les données des membres hors de l'application, **y compris vers ses clients**. Les données d'un profil ne peuvent être montrées qu'aux personnes liées à ce profil. Plusieurs exigences doivent donc exclure les statistiques des profils personnels récupérées via LinkedIn :
- SUI-05 (rapport PDF que l'agence transmet à son client) ;
- SUI-06 (export CSV) ;
- PLA-06 (synchronisation vers Google Sheet).

Seuls l'URL du post, la date et le statut restent exportables. La matrice des droits, où le Lecteur voit toutes les statistiques, est à restreindre pour les profils.

### L8. « Technical Sign Off » : une recette LinkedIn plus large que le périmètre du produit

LinkedIn déploie une recette technique avec démonstration (exigences CM-001 à CM-028). Elle inclut des fonctions absentes du cahier des charges : lecture de tous les posts d'une page, commentaires et réponses, mentions, webhooks, statistiques d'abonnés et de pages. Le texte précise que les critères s'apprécient « selon le périmètre envisagé », et la vidéo du palier Standard tolère que l'on signale une fonction absente. **Risque** : LinkedIn peut demander des ajouts avant d'accorder le palier Standard. Il faut prévoir une marge dans le lot 2.

### L9. Le palier « Development » pourrait suffire au pilote Secutop (à tester)

Le palier Development autorise 500 appels par jour pour l'application et 100 par membre. Les 12 comptes Secutop et leur quinzaine de posts par semaine en consomment bien moins. **Hypothèse à vérifier dès la première semaine** : si ce palier permet de publier réellement sur les pages Secutop, le pilote n'a pas besoin du plan B Make. Cela simplifie fortement le lot 1.

### L10. Posts à plusieurs images sur un profil en plan B : non garanti

« Share on LinkedIn » ne documente que l'ancienne API `ugcPosts`, avec une seule image. Le post à plusieurs images (2 à 9) est documenté dans la nouvelle API Posts de la Community Management API. Le critère REC-05 (3 photos sur un profil) n'est donc pas garanti tant que l'accès n'est pas obtenu. Il faut le tester avec l'application A dès la première semaine.

### L11. Versions de l'API

LinkedIn publie une version par mois et en retire chacune environ un an plus tard (la version 202511 s'arrête le 16/11/2026). La règle « monter au moins deux fois par an » fonctionne. La formulation exacte devrait être : « partir de la version la plus récente au démarrage, monter avant chaque date de retrait annoncée ».

---

## 2. Contradictions internes

| Code | Contradiction | Proposition |
| --- | --- | --- |
| C1 | Clé d'isolation : la section 7 filtre par `workspace_id`, SEC-01 par `organization_id`. Plusieurs tables enfants (post_versions, post_media, post_status_history, publish_attempts, social_tokens, account_profiles, reference_posts, template_zones, account_delegates) n'ont ni l'une ni l'autre. | `org_id` + `workspace_id` sur toutes les tables métier, y compris les tables enfants (dénormalisé) ; RLS sur `workspace_id`. |
| C2 | Alertes d'expiration des jetons : J-14 / J-3 (LNK-04), J-7 / J-1 (risques), J-7 (REC-09). | Une seule règle : J-14, J-3, J0. Avec jetons de renouvellement, alerte sur l'expiration du jeton de renouvellement seulement. |
| C3 | Lien de validation : « valable jusqu'au créneau » (VAL-06) contre « 7 jours » (SEC-05). | La plus courte des deux durées. |
| C4 | Bandeau cookies obligatoire (SIT-05, M) contre « mesure sans cookie, pas de bandeau » (10.2). | Mesure d'audience sans cookie, donc pas de bandeau ; SIT-05 ne s'applique que si un traceur soumis à consentement est ajouté. |
| C5 | Connexion Google / Microsoft : « M » dans ONB-01, « lot 2 » dans SEC-03. | Lot 2 (le pilote n'en a pas besoin). |
| C6 | Quotas : « 4 posts IA par semaine » par compte (paliers), quota mensuel (RÈG-20), compteurs par espace (`usage_counters`), facturation par organisation. Images : 4 par mois inclus, alors qu'un post sur deux avec image générée (VIS-04) à 4 posts par semaine représente environ 8 images, voire 16 avec 2 essais. | Une seule unité : quota mensuel par compte, mutualisé au niveau de l'espace. Recaler l'alternance des images sur le quota ou le quota sur l'alternance, une fois le coût réel mesuré pendant le pilote. |
| C7 | « Pas de carrousel » (RÈG-15) contre carrousel PDF (VIS-10). | Préciser « par défaut, modifiable par espace ». |
| C8 | Fournisseur d'IA en question ouverte (12.3 n° 3) alors que la section 8.3 retient déjà Claude. | Acter Claude, ou rouvrir 8.3. |
| C9 | « Développement SimplX » (en-tête) contre « interne ou prestataire ? » (12.3 n° 2). | À trancher (voir questions). |
| C10 | Deux notions de « version » : `post_versions` (corrections du texte) et v2 / v3 (nouvelle ligne `posts` avec `replaces_post_id` et `version_no`). | Garder les deux mais les nommer différemment : **révision** = texte corrigé dans un même post ; **reprise** = nouveau post qui remplace l'ancien. |
| C11 | « Un seul espace **actif** » (LNK-06) contre `UNIQUE (network, external_urn)`, qui interdit aussi de reconnecter un compte révoqué dans un autre espace. | Index unique partiel, limité aux comptes non révoqués. |
| C12 | « Titulaire » est à la fois un rôle d'espace (`workspace_members.role`) et un lien vers un compte (`holder_user_id`). Une com' qui est aussi titulaire de son propre profil ne peut pas avoir deux rôles. | Le titulaire n'est pas un rôle mais un lien (`social_accounts.holder_user_id`). Rôles d'espace : admin, éditeur, membre (salarié qui ne fait que valider), contributeur, lecteur. |
| C13 | Le titulaire « ne lance pas de génération IA » (matrice des droits), mais GEN-08 (« régénérer », « 3 accroches », « raccourcir ») sert surtout au moment de valider. | Le titulaire peut utiliser GEN-08 sur ses propres posts. |

---

## 3. Manques

| Code | Manque | Pourquoi c'est important | Proposition |
| --- | --- | --- | --- |
| M1 | **Pas de visuels dans le lot 1**, alors que le pilote doit débrancher l'outil actuel, qui produit les visuels (Canva, Higgsfield). | Sans visuels, Secutop ne peut pas publier 100 % de ses posts par le SaaS. | Voir P2. |
| M2 | **Liens « Valider » dans les e-mails** (VAL-06) : les antivirus de messagerie (Outlook Safe Links, Mimecast…) ouvrent automatiquement les liens reçus. | Un post serait validé sans que personne ne clique. | Le lien ouvre une page avec un bouton « Confirmer la validation » ; seul le clic sur ce bouton valide (requête POST). |
| M3 | **Post validé dont le compte est déconnecté** (LNK-04) ou post en attente de reprise (« modif ») quand son créneau passe : aucune règle. | Posts bloqués indéfiniment ou publiés hors de propos. | Étendre RÈG-08 à RÈG-11 à ces cas. |
| M4 | **Bascule depuis l'outil actuel** : le document donne la correspondance des tables mais pas la procédure. | Risque de double publication (Make et SaaS sur le même post). | Bascule compte par compte, à une date fixée : un compte est publié par un seul système à la fois. |
| M5 | **Heure d'été** : les créneaux habituels (« mardi 12h ») sont-ils stockés en UTC ? | « Mardi 12h » deviendrait 13h ou 11h selon la saison. | Créneaux habituels en heure locale + fuseau ; seules les dates précises sont en UTC. |
| M6 | **Injection de consignes** : flux RSS, sites web, demandes libres et e-mails (IDE-07) sont envoyés à l'IA. | Un texte externe peut détourner la génération (« ignore tes règles… »). | Traiter tout contenu externe comme des données, jamais comme des consignes ; vérification par un second passage ; validation humaine en dernier rempart. |
| M7 | **Consentement des salariés** : un salarié confie son profil personnel à l'outil de son employeur. | RGPD : le consentement d'un salarié envers son employeur n'est pas présumé libre. LinkedIn exige aussi le consentement au stockage. | Ambassadeurs volontaires, consentement recueilli et horodaté à la connexion, retrait possible à tout moment, départ du salarié = déconnexion. |
| M8 | **Transparence IA** (L5) : ni mention « IA », ni avertissement sur les erreurs, ni canal de signalement. | Condition d'accès LinkedIn. | Nouvelle exigence (ex. GEN-12). |
| M9 | **Coût IA par post inconnu** | Impossible de fixer les prix (question ouverte n° 1) sans ce chiffre. | Mesurer pendant le pilote (GEN-11 le permet) avant de fixer les paliers. |
| M10 | **Facture électronique** : selon le calendrier publié (à confirmer sur impots.gouv.fr), la réception est obligatoire pour tous depuis le 1er septembre 2026 et l'émission l'est pour les PME au 1er septembre 2027 (pour les ETI et grandes entreprises, depuis le 1er septembre 2026). Stripe n'est pas une plateforme agréée. | L'entité qui facture devra passer par une plateforme agréée avant l'échéance qui la concerne. | Prévoir le raccordement Stripe → plateforme agréée dans FAC-01 selon la taille de l'entité. |

### Détails du modèle de données (pour les développeurs)

- `planning_cells` : la contrainte `UNIQUE (…, account_id, row_label, …)` porte sur des colonnes qui peuvent être vides. Sans `NULLS NOT DISTINCT` (PostgreSQL 15+), elle laisse passer des doublons.
- Les listes d'identifiants (`account_ids uuid[]`, `post_ids uuid[]`, `photo_asset_ids uuid[]`) ne sont pas protégées par des clés étrangères. Des tables de liaison seraient préférables.
- `posts.status` n'a pas de contrainte `CHECK`, alors que les 10 statuts sont listés en 6.1.
- `organizations.plan` et `subscriptions.tier` font doublon.
- `post_media` a pour clé primaire `(post_id, position)`, ce qui complique la réorganisation par glisser-déposer. Il faut une contrainte reportable ou une clé propre.
- `has_blocking_markers` : expression régulière insensible à la casse avec accents, à tester (« à compléter », « A COMPLETER »).

---

## 4. Réalisme du planning

### P1. Le lot 1 est trop chargé

Le lot 1 prévoit 10 semaines × 2 développeurs, soit 20 semaines-développeur, pour :
- les organisations et les rôles ;
- la connexion LinkedIn (profils et pages) et les fiches de compte ;
- le planning en grille ;
- la génération IA (avec vérification et reprise) ;
- la validation sur mobile et la file de publication ;
- les e-mails ;
- l'import du PAM et la migration.

Ce n'est tenable qu'en coupant fortement. De plus, la publication sur les pages dépend d'un accord LinkedIn au délai inconnu, et les visuels manquent (M1).

### P2. Proposition : découper le lot 1 pour s'attaquer d'abord au plus risqué et au plus pénible

Proposition, à discuter :

| Incrément | Contenu | Ce que Secutop y gagne | Ce qui reste comme aujourd'hui |
| --- | --- | --- | --- |
| **1a. Valider et publier** | Comptes et rôles, connexion LinkedIn, posts, validation sur mobile, file de publication, replanification, e-mails. Les posts **arrivent de la tâche Claude actuelle** par une API d'import. | Fin du compte Claude par validateur et de Make ; plusieurs images par post. C'est aussi le test grandeur nature de l'intégration LinkedIn, le principal risque. | Rédaction, visuels, PAM |
| **1b. Planifier et rédiger** | Planning, banque de sujets, import du PAM, ligne éditoriale, fiches de compte, génération IA, vérification, reprise. | Fin des tâches Claude programmées | Visuels |
| **1c. Visuels** | Médiathèque, modèles intégrés, rendu PNG, connecteur générateur d'images (et Canva si nécessaire). | Chaîne complète dans le SaaS | — |

Cet ordre livre de la valeur toutes les 3 à 4 semaines, et confronte le produit à LinkedIn dès le premier mois plutôt qu'à la fin.

---

## 5. Décisions à prendre

| N° | Décision | Recommandation | Décision prise le 13/11/2026 |
| --- | --- | --- | --- |
| D1 | Qui développe et selon quel mode ? | À préciser | **SimplX développe.** La v1.1 du cahier des charges sert de base au chiffrage ; viendront ensuite les maquettes et les tickets. |
| D2 | Entité juridique qui porte l'application LinkedIn, le produit et la facturation | À trancher avant de créer l'application LinkedIn (L2) | **SimplX.** L'application est validée par un super-admin de la page LinkedIn de SimplX. |
| D3 | Délégation de validation sur les **profils personnels** | Pages : délégation autorisée. Profils : validation par le titulaire, sauf accord écrit de sa part (L5) | **Conservée telle quelle** sur tous les comptes. Risque inscrit en 12.2 du cahier ; délégation présentée telle quelle à LinkedIn et désactivable par réglage global si LinkedIn l'exige. |
| D4 | Découpage du lot 1 | 1a → 1b → 1c (P2) | **Adopté.** |
| D5 | Fournisseur d'IA | Claude, sous réserve d'un contrat conforme à L5 (3) et de garanties UE à vérifier | Appliqué dans la v1.1 (déjà retenu en 8.3 de la v1). |
| D6 | Hébergement | À choisir au lot 0 (France ou UE, voir 8.1) | À proposer par SimplX. |
| D7 | Statistiques des profils personnels | Les retirer du rapport et des exports ; vérifier la durée de conservation (L6, L7) | Appliqué dans la v1.1 (règle LinkedIn, pas un choix). |

Toutes les propositions des sections 2 à 4 (C1 à C13, M1 à M10, P2) ont été intégrées dans la v1.1 du cahier des charges, avec le code du point entre crochets à chaque endroit modifié.

---

## Sources consultées

- [Community Management API – vue d'ensemble](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview)
- [Community Management – revue des applications](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review)
- [Community Management – exigences d'intégration (Technical Sign Off)](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/integration-requirements-community-management)
- [Jetons de renouvellement](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)
- [Developer AI Policy](https://learn.microsoft.com/en-us/linkedin/marketing/developer-ai-policy)
- [Usages restreints des API Marketing](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases)
- [Durées de conservation des données](https://learn.microsoft.com/en-us/linkedin/marketing/data-storage-requirements)
- [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)
- Calendrier de la facture électronique : sources secondaires ([Pennylane](https://www.pennylane.com/fr/fiches-pratiques/facture-electronique/facturation-electronique-dates-cles-et-calendrier), [B2Brouter](https://www.b2brouter.net/fr/facture-electronique-calendrier/)), à confirmer sur impots.gouv.fr

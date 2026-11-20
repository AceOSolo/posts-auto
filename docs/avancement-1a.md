# Avancement de l'incrément 1a « Valider et publier »

État au 13 novembre 2026. Périmètre et critères : cahier des charges v1.1, section 11.

**En résumé** : tout ce qui ne dépend que de nous est construit et vérifié. Il reste à brancher le vrai LinkedIn, qui attend l'application LinkedIn A de SimplX, et l'envoi réel des e-mails, qui attend la clé Brevo. Le reste est déjà vérifié avec un LinkedIn simulé : 373 tests automatiques et 37 vérifications de fumée sur l'application lancée.

## Périmètre de l'incrément

| Élément | État | Où |
| --- | --- | --- |
| Organisations, espaces, rôles | Fait | `packages/db` (migrations 001-006), `packages/services/src/access.ts` |
| Invitations, rôles, retrait de membres (ONB-07) | Fait | Page « Réglages » de l'espace |
| Connexion LinkedIn des **profils** (LNK-01) | Fait, à brancher | Parcours testé en mode simulé ; attend l'application A |
| Connexion LinkedIn des **pages** (LNK-02) | Fait le 20/11/2026, avec LinkedIn simulé | Lecture des pages administrées (organizationAcls, organizations) à vérifier dès l'accès à la Community Management API |
| Fiche du compte : titulaire, délégués, consentement, échéance (LNK-03, ROL-01, LNK-09) | Fait | Pages « Comptes » et « Réglages » |
| Surveillance et renouvellement des connexions (LNK-04) | Fait | Tâche quotidienne `connexions` |
| Déconnexion, pause d'un compte (LNK-05, LNK-07) | Fait | — |
| Posts, révisions, photos (jusqu'à 9, ordre réglable) | Fait | — |
| Validation sur mobile : « Mes posts », détail, décision (VAL-01 à VAL-04, VAL-07 à VAL-10) | Fait | `apps/web` |
| Liens « Valider » dans l'e-mail (VAL-06, priorité S) | Fait | Lien à usage unique dans les rappels, page de confirmation (M2) |
| File de publication, nouvelles tentatives, issues incertaines (PUB-01 à PUB-05) | Fait, à brancher | Tâche `publication` ; attend l'application A |
| Replanification (RÈG-08 à RÈG-11) | Fait | Tâche `replanification` |
| Rappels 24 h et 3 h, récapitulatif du lundi (VAL-05) | Fait | Tâche `rappels` |
| E-mails (Brevo) et réglage des notifications (NOT-01) | Fait, à brancher | Attend `BREVO_API_KEY` et un domaine d'envoi authentifié |
| API d'échange pour la tâche Claude actuelle (PUB-10) | Fait | `docs/api-echange.md` |
| Export des données personnelles (RGPD) | Fait | Page « Mon compte » |
| Bascule compte par compte (RÈG-21) | Outil prêt | Pause et reprise d'un compte ; la procédure reste à dérouler avec Secutop |

## Critères de recette de l'incrément 1a

| Réf. | Scénario | État | Preuve |
| --- | --- | --- | --- |
| REC-01 | Accès au post d'un autre client | **Conforme** : 404 et ligne « accès refusé » au journal applicatif | `rls.test.ts`, `post-queries.test.ts`, test de fumée |
| REC-02 | Connexion d'un profil puis d'une page | **Profil conforme en mode simulé** ; page à faire | `accounts.test.ts`, test de fumée « connexion LinkedIn » |
| REC-05 | 3 photos réordonnées, publication dans l'ordre | **Conforme avec le faux LinkedIn** ; à confirmer sur un vrai profil (point L10) | `publication.test.ts`, `client.test.ts` |
| REC-06 | Validé 10 min après le créneau → publié dans l'heure | **Conforme** | `post-actions.test.ts`, `slots.test.ts` |
| REC-07 | Non validé à l'heure → replanifié, titulaire prévenu | **Conforme** (lendemain même heure, décision du 13/11) | `reschedule-job.test.ts` |
| REC-08 | Coupure de LinkedIn → 3 essais, erreur, alerte, pas de doublon | **Conforme** | `publication.test.ts` |
| REC-09 | Jeton qui expire → e-mail avec lien de reconnexion | **Conforme** (J-14, J-3, lien vers la page des comptes) | `token-check.test.ts`, `mail.test.ts` |
| REC-11 | Validation complète depuis un smartphone | **Conforme** à l'écran (mise en page mobile, cibles de 44 px, sans JavaScript) ; à essayer sur de vrais téléphones | Test de fumée (formulaire, ajout de photo) |
| REC-12 | Export RGPD d'un utilisateur | **Conforme** (JSON + images, limité à la personne, ouvert par Windows) | `export.test.ts`, test de fumée |
| REC-13 | Même post envoyé deux fois par l'API | **Conforme**, y compris en parallèle | `exchange.test.ts`, test de fumée |
| REC-14 | Lien « Valider » ouvert par un antivirus | **Conforme** : ouvrir le lien ne valide rien, seul « Confirmer » valide, une seule fois | `approval-links.test.ts`, test de fumée |
| REC-15 | Bascule de Make vers le SaaS sans doublon | **Outil prêt** (compte en pause tant que Make publie) ; à dérouler compte par compte | `members.test.ts` |
| REC-16 | Créneau « mardi 12h00 » de part et d'autre du changement d'heure | **Conforme** | `workspace-calendar.test.ts`, `reschedule.test.ts` |

REC-03, REC-04, REC-10 et REC-17 relèvent de l'incrément 1b, REC-18 de l'incrément 1c.

## Ce qui attend une action hors du code

1. **SimplX — application LinkedIn A**, sur developer.linkedin.com :
   - produits « Sign In with OpenID Connect » et « Share on LinkedIn » ;
   - rattachée à la page LinkedIn de SimplX et validée par un super-administrateur de cette page ;
   - adresse de retour à déclarer : `<APP_URL>/comptes/connecter/retour`.

   Fournir `LINKEDIN_CLIENT_ID` et `LINKEDIN_CLIENT_SECRET`. Premier test à faire : un post à 3 photos sur un profil réel (point L10).
2. **SimplX — application LinkedIn B** : demande d'accès à la Community Management API, pour les pages (section 8.2).
3. **SimplX — Brevo** : domaine d'envoi authentifié (SPF, DKIM, DMARC), clé d'API, adresse d'expéditeur.
4. **Hébergement** : base PostgreSQL 16, stockage des images (S3 dans l'UE), application web et processus des tâches de fond, sauvegardes (NF-05).
5. **Secutop — tâche Claude actuelle** : la faire déposer ses posts par l'API d'échange (`docs/api-echange.md`) au lieu de l'outil de validation actuel.

## Écarts assumés et points ouverts

- **Issues incertaines de publication** : jamais de nouvel essai automatique. Une personne vérifie sur LinkedIn (précision de PUB-04, décision 0003).
- **Délégation sur les profils personnels** : conservée par décision du cadrage ; risque inscrit en 12.2 du cahier.
- **Statistiques LinkedIn (SUI-03)** : pas dans l'incrément 1a.

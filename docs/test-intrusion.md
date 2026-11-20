# Test d'intrusion externe (SEC-10) : cahier des charges du prestataire

À réaliser avant l'ouverture commerciale (fin du lot 2), sur l'environnement de préproduction, avec la même configuration que la production. Les vrais secrets ne sont pas fournis : clés de test Stripe, application LinkedIn de test.

## Objectifs

1. **Cloisonnement des clients (REC-01)** : aucune personne d'une organisation ne doit voir, modifier ou exporter les données d'une autre. Cela couvre les posts, les images, le planning, les statistiques, les rapports PDF, les exports CSV et le journal d'audit, ainsi que l'API d'échange.
2. **Authentification** : lien de connexion par e-mail, connexion Google et Microsoft (OpenID Connect avec PKCE), double authentification (TOTP, codes de secours, limite de 5 essais), sessions (cookie `__Host-session`, révocation), session du support (ADM-02).
3. **Autorisations** : rôles (propriétaire, administrateur, éditeur, contributeur, lecteur), titulaires et délégués, back-office (`/admin`, réservé à l'éditeur et à la double authentification).
4. **Entrées et intégrations** :
   - **Lecture d'adresses externes** : flux RSS, site pour la ligne éditoriale et la charte, feuille Google Sheets. Une protection SSRF est en place et doit être vérifiée.
   - **Envois sortants** : webhooks des clients (LNK-08).
   - **Webhook Stripe** : signature vérifiée.
   - **Envoi de fichiers** : photos, logo, avatar (contrôle du type et de la taille, métadonnées retirées).
   - **Injection de consignes dans l'IA** : posts, sources, demandes.
5. **Paiement** : souscription et changement de formule, quantités, packs, rejeu d'événements Stripe, suspension et reprise.
6. **En-têtes et configuration** : en-têtes de sécurité, cookies, protection contre la falsification de requête (actions serveur), absence de fuite d'informations dans les messages d'erreur.

## Périmètre

| Surface | Adresses |
| --- | --- |
| Site public | `/`, `/en`, pages légales, `/inscription`, `/connexion`, `/llms.txt`, `/sitemap.xml` |
| Application | toutes les pages connectées, `/media/*`, exports (`/tableau/*/export`, `/abonnement/*/export`, `/planning/*/export`, `/moi/export`), rapports (`/tableau/*/rapport`) |
| Validation sans compte | `/valider/<jeton>` |
| API d'échange | `/api/v1/*` (clés d'API) |
| Retours d'autorisation | `/comptes/connecter/retour`, `/connexion/sso/*/retour`, `/visuels/canva/retour` |
| Webhook | `/api/stripe/webhook` |
| Back-office | `/admin/*` |

**Hors périmètre** : LinkedIn, Stripe, Canva, Brevo, Anthropic, Higgsfield (services tiers), déni de service, ingénierie sociale.

## Ce que SimplX fournit

- **Comptes de test** : deux organisations distinctes, l'une entreprise, l'autre agence avec deux clients. Dans chacune, une personne par rôle, dont un propriétaire avec la double authentification.
- **Back-office** : un compte avec la double authentification.
- **API d'échange** : des clés d'API de chaque portée.
- **Documentation** : les décisions d'architecture (`docs/decisions/`), le modèle de données et l'avancement des incréments.

## Livrables attendus

- Rapport : vulnérabilités classées par gravité (CVSS), preuves, recommandations.
- Contre-test après corrections.
- Synthèse non technique, communicable aux clients qui la demandent.

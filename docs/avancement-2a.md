# Avancement de l'incrément 2a « Inscription et démarrage »

Périmètre : lot 2 (« Commercialisation », section 11 du cahier des charges), partie indépendante des prix. Exigences ONB-01 à ONB-04, ONB-06 et ONB-08.

**Pourquoi cet incrément d'abord** : la facturation (abonnements Stripe, quotas par formule, factures : FAC-01 à FAC-07) attend les décisions sur les prix et le contenu des formules. Tout ce qui permet à un client de s'inscrire seul et de démarrer n'en dépend pas.

**En résumé (20 novembre 2026)** : un client peut créer son compte seul, démarrer un essai gratuit de 14 jours et être guidé jusqu'à ses premiers posts. Les tests automatiques passent (738), ainsi que les 95 vérifications de fumée, qui parcourent l'inscription et le démarrage de bout en bout.

## Étapes

| # | Étape | Exigences | État |
| --- | --- | --- | --- |
| 1 | Inscription en libre-service, confirmation par e-mail, création de l'organisation et de son premier espace ; assistant de démarrage en six étapes, indicateur « prêt à publier » | ONB-01, ONB-02, ONB-03, ONB-08 | Fait : pages « Créer un compte », « Créer mon espace », « Démarrage » ; indicateur sur « Mes posts » |
| 2 | Essai gratuit : 14 jours, 3 comptes LinkedIn, 10 posts rédigés ; bandeau d'essai | ONB-06 | Fait |
| 3 | Ligne éditoriale proposée par l'IA à partir du site et de posts collés | ONB-04 | Fait : « Proposer avec l'IA » sur la page « Ligne éditoriale » |

## Choix faits en cours de route

- **Rien n'est créé avant la confirmation de l'adresse.** La demande attend dans une table réservée au système. Le lien de confirmation mène à une page qui demande un clic sur « Créer mon espace », car les antivirus de messagerie ouvrent les liens.
- **Pas d'énumération des comptes** : une adresse déjà inscrite reçoit un lien de connexion, avec le même message affiché.
- **Agence** : le premier espace s'appelle « Premier client », à renommer à l'étape 1 de l'assistant.
- **Avancement calculé, pas enregistré** : une étape faite ailleurs dans l'application compte. Seule la fermeture de l'assistant est enregistrée. Les espaces créés avant l'incrément (Secutop) sont considérés comme démarrés.
- **Fin de l'essai** : la rédaction s'arrête et aucun nouveau compte ne peut être connecté, mais les posts déjà validés partent toujours. Couper la publication relève des impayés (FAC-06), avec la facturation.
- **Essai et organisations existantes** : une organisation est en essai tant qu'elle a une date de fin d'essai et pas de client Stripe. Secutop n'a pas de date de fin d'essai, donc aucune limite.
- **Lecture du site** : même protection contre l'accès au réseau interne que les flux RSS, désormais commune (`safeFetchText`).

## Ce qui attend une action ou une décision

1. **SimplX — prix et formules** (lot 2) : prix par compte, posts et images inclus par formule, comportement au plafond (FAC-04). C'est ce qui débloque la facturation.
2. **SimplX — avant d'ouvrir l'inscription au public** :
   - rédiger les conditions générales, la politique de confidentialité et les mentions légales, puis les lier depuis la page d'inscription ;
   - configurer l'envoi d'e-mails (Brevo, domaine authentifié), sans quoi les liens de confirmation arrivent en indésirables.
3. ~~**Message de fin d'essai**~~ : il mène maintenant à la page « Abonnement » (incrément 2b).

## Reste du lot 2

- ~~**Facturation** (FAC-01 à FAC-07)~~ : faite, voir `avancement-2b.md` ; les prix restent à fixer.
- **Connexion Google et Microsoft** (ONB-01b), **double authentification** (SEC-04).
- **Espace Agence** : plusieurs clients, refacturation (FAC-07).
- **Statistiques**, **administration** (ADM-01 à ADM-04), **site vitrine**, **test d'intrusion** (SEC-10).
- **Charte extraite du site** (ONB-05, S), **import d'un planning pendant l'assistant** (ONB-09, S : l'import CSV existe déjà dans « Planning »).

# Avancement de l'incrément 2c « Sécurité des accès »

Périmètre : lot 2, exigences SEC-04 (double authentification) et ONB-01b (connexion Google et Microsoft).

## SEC-04 : double authentification (fait, 20 novembre 2026)

- **Code à 6 chiffres** donné par une application d'authentification (TOTP, RFC 6238), demandé à chaque connexion après le lien reçu par e-mail.
  - **Mise en place** : sur la page « Double authentification » (`/securite`, depuis « Mon compte »), il suffit de scanner un code QR et de saisir un premier code.
  - **Codes de secours** : 10 codes à usage unique, montrés une seule fois.
- **Obligatoire pour les propriétaires et les administrateurs**, avec 7 jours pour la mettre en place.
  - Le délai court à partir de la création du compte, ou du 20 novembre 2026 pour les comptes plus anciens.
  - Pendant le délai, un bandeau rappelle la date limite. Ensuite, toutes les pages mènent à la mise en place.
  - Pour ces rôles, elle ne peut pas être désactivée. Une autre personne peut l'activer, puis la désactiver avec un code.
- **Protections** :
  - le secret est chiffré comme les jetons LinkedIn (SEC-02) ;
  - un code ne sert qu'une fois ;
  - l'horloge du téléphone peut avoir 30 secondes d'avance ou de retard ;
  - au 5e code faux, la session est révoquée et il faut demander un nouveau lien ;
  - tant que le code n'est pas saisi, rien n'est accessible, ni les pages, ni les images, ni les exports.
- **Activation** : les autres sessions ouvertes de la personne demandent le code à la visite suivante. La session où l'activation a été faite reste ouverte.
- **Vérification** : 765 tests automatiques, dont les vecteurs de la RFC 6238, et 123 vérifications du test de fumée. Celui-ci parcourt l'activation, une nouvelle connexion, un code faux, puis le bon code.

## ONB-01 : connexion avec Google ou Microsoft (fait, 20 novembre 2026)

- **Où** : boutons « Se connecter avec Google » et « Se connecter avec Microsoft » sur la page de connexion, à côté du lien par e-mail.
- **Protocole** : OpenID Connect, code d'autorisation avec PKCE et « state » dans un cookie de 10 minutes. Le jeton d'identité est vérifié : application destinataire, émetteur et expiration.
- **Connexion seulement, pas d'inscription par ce biais** : l'adresse doit être celle d'un compte existant, et **vérifiée** par le fournisseur.
  - Google : `email_verified`.
  - Microsoft : `xms_edov`, qui confirme que le domaine est vérifié par le client. Une adresse Microsoft non garantie renvoie au lien par e-mail.
- **Double authentification** : demandée ensuite comme après un lien.
- **Mode simulé** : `SSO_MODE=fake` remplace les fournisseurs par une page de l'application (développement, test de fumée).

**À faire par SimplX** :

- **Google** : créer le client OAuth « Application Web » dans Google Cloud, avec l'adresse de retour `https://<domaine>/connexion/sso/google/retour`, puis définir `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`.
- **Microsoft** : inscrire l'application dans Entra ID (comptes de toute organisation), avec l'adresse de retour `https://<domaine>/connexion/sso/microsoft/retour`. Ajouter les revendications facultatives `email` et `xms_edov` au jeton d'identité, puis définir `MICROSOFT_CLIENT_ID` et `MICROSOFT_CLIENT_SECRET`.

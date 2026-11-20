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

## Reste

- **ONB-01b** : connexion avec Google ou Microsoft. Elle demande des applications OAuth chez Google et chez Microsoft, à créer par SimplX.

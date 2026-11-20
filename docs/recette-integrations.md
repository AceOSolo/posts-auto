# Recette avec les vrais services

Les tests automatiques et le test de fumée utilisent des services simulés : LinkedIn, Stripe, Canva, Google, Microsoft, IA et images. Avant l'ouverture commerciale, chaque intégration est donc vérifiée une fois **pour de vrai**, en préproduction, sur des comptes de test.

## 1. Vérification automatique de la configuration

```sh
docker compose -f deploy/compose.prod.yaml run --rm worker verifier-integrations
# en développement : npm run verifier-integrations -w @posts-auto/worker
```

La commande ne fait que lire : rien n'est publié, envoyé ni facturé. Elle contrôle :

- l'adresse de l'application et sa page de santé ;
- les migrations ;
- la clé de chiffrement ;
- la clé Anthropic et le modèle ;
- la clé Brevo et l'expéditeur validé ;
- la clé Stripe, chaque prix des formules et des packs, le webhook et ses six événements ;
- l'application LinkedIn et l'état des connexions ;
- Google, Microsoft et Canva.

Tout doit être ✔, ou – pour ce qui n'est pas utilisé.

## 2. Parcours à faire à la main

Le tableau sert de procès-verbal : cocher, dater, noter l'anomalie éventuelle.

| # | Parcours | Résultat attendu | OK |
| --- | --- | --- | --- |
| **LinkedIn** | | | |
| L1 | Connecter un profil de test (Comptes → Connecter) | Compte « connecté », échéance du jeton affichée | ☐ |
| L2 | Connecter une page de test administrée par ce profil | La page apparaît avec son nom | ☐ |
| L3 | Valider un post de texte au créneau suivant | Publié une fois, lien LinkedIn sur la page du post | ☐ |
| L4 | Post avec 1 image, puis avec 3 images | Images dans l'ordre, texte alternatif présent | ☐ |
| L5 | Carrousel PDF (VIS-10) sur la page | Document LinkedIn lisible, pages dans l'ordre | ☐ |
| L6 | Premier commentaire (PUB-07) | Commentaire sous le post, au nom de l'auteur | ☐ |
| L7 | Mention d'une page (PUB-08) | Mention cliquable sur LinkedIn | ☐ |
| L8 | Statistiques à J+1 (SUI-03) | Chiffres au tableau de bord, ou « indisponible » si LinkedIn ne les donne pas | ☐ |
| L9 | Révoquer l'accès côté LinkedIn | Compte « expiré » au contrôle quotidien, alerte reçue | ☐ |
| **Rédaction** | | | |
| A1 | Rédaction d'une semaine pour 2 comptes (IA réelle) | Posts dans le ton, aucun fait inventé, marqueurs si une information manque | ☐ |
| A2 | Demande dictée, puis « Raccourcir » et « 3 accroches » | Résultats en français, coût visible dans le suivi | ☐ |
| A3 | Images générées (si Higgsfield) | Ni personne identifiable ni texte ; mention « image générée par IA » | ☐ |
| **Paiement** (Stripe en mode test, cartes de test) | | | |
| S1 | Souscrire en mensuel (carte 4242…) | Abonnement actif, facture reçue, TVA juste | ☐ |
| S2 | Souscrire en SEPA (IBAN de test) | Abonnement actif après confirmation | ☐ |
| S3 | Carte refusée, puis 3D Secure | Refus clair ; authentification demandée | ☐ |
| S4 | Ajouter un compte LinkedIn | Quantité +1 chez Stripe, au prorata | ☐ |
| S5 | Échec de prélèvement (carte 4000 0000 0000 0341) | « Paiement en échec », relance J+3 (avancer l'horloge de test Stripe) | ☐ |
| S6 | Pack de posts | Quota du mois augmenté | ☐ |
| S7 | Résilier depuis le portail | Résiliation programmée affichée, puis fin à l'échéance | ☐ |
| S8 | Numéro de TVA intracommunautaire d'un autre pays | Autoliquidation sur la facture | ☐ |
| **E-mails** | | | |
| E1 | Lien de connexion vers Gmail, Outlook, une messagerie d'entreprise | Reçu en boîte de réception, pas en indésirables | ☐ |
| E2 | Note sur mail-tester.com | 9/10 ou plus | ☐ |
| E3 | Publication manuelle (PUB-09) | Texte et images joints | ☐ |
| E4 | Rapport mensuel par e-mail (SUI-05) | PDF joint, lisible | ☐ |
| **Connexions facultatives** | | | |
| O1 | Connexion Google avec une adresse Google Workspace | Connecté, double authentification demandée si active | ☐ |
| O2 | Connexion Microsoft avec une adresse de domaine vérifié | Connecté ; adresse non vérifiée : refus clair | ☐ |
| O3 | Canva : connecter, ajouter un modèle de marque, préparer un visuel | Copie dans le Canva du client, PNG dans le post | ☐ |
| O4 | Webhook vers un scénario Make (LNK-08) | Signature vérifiée par le scénario, post publié par Make | ☐ |
| **Exploitation** | | | |
| X1 | Sauvegarde immédiate, puis restauration dans une base d'essai | Base restaurée, données présentes | ☐ |
| X2 | Redémarrage du serveur | Tout redémarre seul, aucun post manqué ni publié deux fois | ☐ |
| X3 | Score Lighthouse mobile du site (SIT-07) | 90 ou plus en performance, accessibilité et référencement | ☐ |

## 3. Ensuite

- **Pilote** : quatre semaines de publication réelle pour Secutop (jalon du lot 1).
- **Sécurité** : test d'intrusion (`docs/test-intrusion.md`).

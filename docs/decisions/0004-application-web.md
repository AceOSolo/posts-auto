# 0004 – Application web de l'incrément 1a

13 novembre 2026 · statut : adopté

## Contexte

L'incrément 1a remplace la page de validation actuelle, hébergée dans claude.ai et qui exige un compte Claude par validateur. Le cahier demande une validation pensée d'abord pour le téléphone (VAL-01, NF-09), faisable sans zoom (REC-11), et accessible au niveau AA (NF-08).

## Décisions

1. **Next.js 16 (App Router)**, comme recommandé en 8.1, rendu côté serveur. Les paquets du dépôt sont compilés par Next.js (`transpilePackages`). Le pilote PostgreSQL reste hors de l'empaquetage (`serverExternalPackages`).
2. **Imports relatifs en `.ts`** dans tous les paquets. Turbopack ne traduit pas `./x.js` vers `./x.ts` ; Next.js, Vitest, tsx et Node lisent tous directement les `.ts` (`allowImportingTsExtensions`, `rewriteRelativeImportExtensions`).
3. **Chaque action est un vrai formulaire HTML, traité par une action serveur** : valider, demander une modification, refuser, corriger, changer le créneau, retirer, réessayer. Avantages :
   - tout fonctionne sans JavaScript, donc sur tout téléphone ;
   - Next.js refuse les formulaires envoyés depuis un autre site (CSRF, SEC-06), ce que le test de fumée vérifie ;
   - le résultat revient sous forme d'un **code** connu dans l'adresse, jamais d'un texte libre, qui serait une porte d'injection de contenu.
4. **Les pages n'accèdent aux données que par `@posts-auto/services`**, donc sous l'identité de la personne (RLS). Un post d'un autre client donne une page 404 (REC-01), et les images sont servies par `/media/[id]` avec le même contrôle (SEC-07 : jamais d'adresse publique).
5. **Connexion en deux temps** : l'e-mail mène à une page avec un bouton « Se connecter », et c'est ce clic qui consomme le lien. Les antivirus de messagerie peuvent donc ouvrir le lien sans le griller. Le cookie de session est `HttpOnly`, `SameSite=Lax` et, en production, préfixé `__Host-` (sécurisé et limité au domaine).
6. **Aperçu fidèle du rendu LinkedIn** :
   - texte coupé à « … voir plus » après environ 210 caractères, comme sur mobile ;
   - marqueurs [À COMPLÉTER] surlignés (VAL-03), bouton « Valider » désactivé tant qu'il en reste ;
   - mention « Image générée par IA » (VIS-12) et rappel de vérifier les faits (politique IA de LinkedIn, GEN-12).
7. **Données de démonstration et test de fumée** :
   - `npm run seed -w @posts-auto/web` recrée un espace de démonstration ;
   - `npm run smoke -w @posts-auto/web` vérifie l'application lancée : pages, isolation entre clients, images, formulaire de validation, refus CSRF.

## Reste à faire

- Envoi réel des e-mails (Brevo) : les liens s'affichent pour l'instant dans la console.
- Connexion d'un compte LinkedIn (OAuth) : attend l'application LinkedIn A de SimplX.
- Rappels avant le créneau (VAL-05), liens de validation depuis l'e-mail (VAL-06), relance depuis la vue équipe (VAL-07).
- Application installable sur téléphone (NOT-02, lot 2).
- Vue équipe : le calendrier utilise le fuseau par défaut (Europe/Paris) au lieu de celui de l'espace ; à corriger avant un client hors de France.

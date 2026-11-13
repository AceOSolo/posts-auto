# Avancement de l'incrément 1c « Visuels »

Périmètre et critères : cahier des charges v1.1, section 5.6 (VIS-01 à VIS-13) et section 11. Conception : décision 0006.

**Jalon de sortie** : Secutop publie 100 % de ses posts par le SaaS pendant 4 semaines ; Make et l'outil Claude sont entièrement débranchés.

**En résumé (13 novembre 2026)** : toutes les exigences « M » de l'incrément sont construites et testées. Chaque post rédigé par l'IA arrive « à valider » avec son visuel :
- un modèle de l'espace, rempli par l'IA, rendu en PNG ;
- une fois sur deux environ, une photo : de la médiathèque quand l'une convient, sinon générée par IA et signalée comme telle.

Il faut maintenant brancher Higgsfield avec une vraie clé : le connecteur est écrit d'après la documentation publique, mais n'a pas encore été essayé contre l'API réelle. Il faut aussi la charte, les photos et les modèles de Secutop.

Les tests automatiques passent (713), ainsi que les 82 vérifications de fumée. La chaîne y est vérifiée de bout en bout avec un modèle et un générateur d'images simulés.

## Étapes

| # | Étape | Exigences | État |
| --- | --- | --- | --- |
| 1 | Moteur de rendu : modèles à zones nommées, PNG côté serveur, taille de texte ajustée, espaces insécables, contrôle de lisibilité, 4 modèles de départ | VIS-01, VIS-03, VIS-11 | Fait : paquet `@posts-auto/visuals` |
| 2 | Schéma : modèles, médiathèque, recette des visuels, visuels à refaire, budget d'images | Section 7 | Fait : migrations 018 et 019 |
| 3 | Remplissage par l'IA, alternance photo / texte, choix du modèle | VIS-03, VIS-04, VIS-08 | Fait : `fillVisual`, `photoTurns`, `rankTemplates` |
| 4 | Préparation d'un visuel : photo gardée, de la médiathèque ou générée (budget, 2 images par post), meilleur rendu gardé, coûts | VIS-03 à VIS-05, VIS-11, VIS-12 | Fait : `prepareVisual`, `storeVisual` |
| 5 | Visuels dans la chaîne de rédaction ; « refaire le visuel » par le worker | VIS-03, VIS-13, REC-18 | Fait : rédaction hebdomadaire, demandes sans photo, reprises ; tâche « visuels » |
| 6 | Page du post : visuel, mention IA, points à vérifier, « Refaire le visuel » | VIS-12, VIS-13 | Fait |
| 7 | Services : modèles, charte, budget, médiathèque, part des visuels avec photo par compte | VIS-01, VIS-02, VIS-04, VIS-05, VIS-08, ONB-05 | Fait |
| 8 | Écrans : modèles, éditeur avec aperçu en direct, charte et budget, médiathèque | VIS-01, VIS-02, VIS-05, VIS-08 | Fait : pages « Visuels », « Modèle de visuel », « Médiathèque » ; réglage sur la fiche du compte |
| 9 | Connecteur Higgsfield | VIS-05 | Écrit et testé avec une API simulée ; à essayer avec une vraie clé |
| 10 | Polices de la charte | VIS-02 | Fait : Inter, Montserrat ou Lora pour chaque zone de texte ; police des titres dans la charte |
| 11 | Contrôle des images générées | VIS-11, VIS-05 | Fait : l'IA examine chaque image (personne identifiable, texte, logo, défaut, contenu choquant) ; image écartée refaite une fois ; description reprise dans le texte alternatif |

## Critère de recette de l'incrément 1c

| Réf. | Scénario | État |
| --- | --- | --- |
| REC-18 | Génération d'un post avec image générée dans un modèle | Conforme avec le générateur simulé (`integration.test.ts`, test de fumée) : visuel rendu en PNG de 1080 px, texte ajusté à sa zone et jamais sous la taille minimale, mention « image générée par IA » enregistrée (image et visuel marqués, texte alternatif publié « Illustration générée par IA »). À refaire avec Higgsfield |

## Ce qui attend une action hors du code

1. **SimplX — Higgsfield** :
   - créer la clé d'API sur la console Higgsfield (identifiant et secret) et approvisionner les crédits ;
   - régler `IMAGE_MODE=higgsfield`, `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET`, puis `HIGGSFIELD_COST_USD` (coût d'une image, GEN-11) ;
   - faire un premier essai réel du connecteur : adresse, paramètres et réponse du modèle ;
   - choisir le modèle (`HIGGSFIELD_MODEL`) : SOUL Standard par défaut, pensé pour les portraits et la mode. Un modèle plus généraliste conviendra peut-être mieux à des scènes de travail sans personne identifiable. Ses paramètres sont à vérifier : le connecteur ne lui envoie que la consigne et la proportion ;
   - vérifier les conditions d'utilisation : usage commercial des images, et sort des consignes envoyées.
2. **Hébergement** : le serveur web et le worker chargent un module natif (`@napi-rs/canvas`). Il est fourni précompilé pour Linux x64 (glibc et musl) ; à confirmer sur l'hébergeur retenu.
3. **Secutop — charte et modèles** (page « Visuels ») :
   - saisir les couleurs, la police des titres et le logo ;
   - remettre les modèles de départ à la charte ;
   - adapter ou copier les modèles pour retrouver la mise en page des visuels Canva actuels ;
   - fixer le budget mensuel d'images (30 par défaut).
4. **Secutop — médiathèque** : déposer les vraies photos (chantiers, équipes, locaux, formations), avec un nom, un dossier et des mots-clés précis. C'est ce qui permet à l'IA de les choisir.
5. **Secutop — réglage par compte** : part des visuels avec photo, sur la fiche de chaque compte (un sur deux par défaut).
6. **Bascule** : arrêter la production de visuels dans l'outil actuel (Canva, Higgsfield) compte par compte, puis suivre le jalon : 4 semaines à 100 % par le SaaS.

## Hors de l'incrément ou reporté

- **Autres polices** : trois polices libres sont embarquées (Inter, Montserrat, Lora). Une police propre au client s'ajoute au paquet si sa licence le permet.
- **« Ancien texte de modèle resté »** (VIS-11) : ce cas concerne les modèles Canva, où l'on remplace des textes existants. Les modèles intégrés partent de zones vides.
- **Extraction de la charte depuis le site web** (ONB-05, S).
- **Connecteur Canva** (VIS-07, S) : à faire seulement si Secutop en a besoin pour son pilote. Les modèles intégrés et l'éditeur couvrent le besoin de départ.
- **Personnages de marque** (VIS-06, S), **carrousel PDF** (VIS-10, C).
- **Quotas d'images par formule** (RÈG-19, RÈG-20, FAC-04) : le budget mensuel par espace est en place ; les quotas par abonnement viendront avec le lot 2.

# 0009 – Nom et identité visuelle : Rostra

20 novembre 2026 · statut : adopté · question ouverte n° 3 du cahier (section 12.3)

## Contexte

Le produit s'appelait « Posts LinkedIn » dans l'application, faute de nom. Le cahier proposait trois noms (Valido, Postop, Cadence) et laissait le choix ouvert. Une recherche rapide a montré deux conflits :

- **Postop** est déjà une application médicale de suivi post-opératoire ;
- **Cadence** se heurte à Cadence Design Systems, grand éditeur de logiciels.

SimplX a demandé un nom plus singulier, inventé comme Pharow ou Lemlist, qui évoque la communication d'autrefois.

## Décisions

1. **Le nom : Rostra.** En 338 av. J.-C., après la bataille d'Antium, les Romains fixent les éperons de bronze (*rostra*) des navires pris à l'ennemi sur la tribune aux harangues du Forum. La tribune prend leur nom. On y prenait la parole devant le peuple. Rostra donne la tribune à chaque collaborateur sur LinkedIn.
   - Le nom ne contient ni « Linked » ni « In » : il convient aussi pour l'application LinkedIn.
   - Aucun logiciel de ce nom n'a été trouvé. Les noms proches (Rostr, Rosterna) sont dans le planning d'équipe.
2. **La signature : « Prenez la parole. »** Elle garde toujours son point final.
3. **Le logo.** Un R formé de trois pièces, dessiné sur une grille de 120 unités :
   - une colonne en encre : la tribune ;
   - une bulle en rouge pompéien, à contreforme ronde : la parole ;
   - un éperon en rouge pompéien : la proue des *rostra*.
   Le logotype est en Fraunces, vectorisé.
4. **Les couleurs.** Travertin `#F5EFE4` (fond), Encre `#221C1A` (texte), Pompéien `#A8372A` (la parole, les actions), Ocre `#C8912E` (ce qui attend une décision). Les contrastes du texte atteignent tous le niveau AA. Le bleu de LinkedIn est exclu, pour ne pas se confondre avec lui.
5. **Les polices.** Fraunces pour les titres, Hanken Grotesk pour le texte, sous licence OFL. Le site les héberge lui-même en woff2 (57 Ko et 19 Ko, caractères latins) : aucun appel à Google Fonts.
6. **Une seule source pour la géométrie.** Le logo, les fichiers fournis, les éléments du site et la charte PDF sont produits par les scripts de `docs/marque/outils`. Le composant `Logo` du site est généré : ses couleurs sont des variables CSS, et il suit donc le mode sombre.

## Conséquences

- La charte (PDF de 23 pages) et les logos (72 fichiers) sont destinés au Drive de Secutop, dossier « Rostra », à côté de « Les Employeurs ». Le dossier est créé ; l'envoi des fichiers a échoué le 20/11/2026, faute d'espace de stockage sur le compte Google. Ils ne sont pas dans le dépôt : `docs/marque/sortie/` est ignoré par Git et se régénère.
- L'application, les e-mails, le second facteur d'authentification (nom affiché dans l'application d'authentification), les métadonnées et le fichier llms.txt s'appellent désormais « Rostra ». Les codes de double authentification déjà enregistrés restent valides ; seul leur libellé change pour les nouvelles inscriptions.
- **Reste à faire par SimplX** : vérifier la disponibilité de la marque (INPI, EUIPO, classes 9, 35 et 42) et du nom de domaine, puis déposer la marque. Ces deux vérifications n'ont pas été faites ; elles conditionnent l'usage public du nom.

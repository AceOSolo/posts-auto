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
3. **Une première identité a été refusée** (même jour) : fond crème, encre, une couleur forte et un accent réservé, mêmes proportions et même plan de charte que pour Les Employeurs. Trop proche de la charte précédente. Trois directions nouvelles ont été proposées (sombre et électrique, pop et illustrée, éditoriale et brutaliste), jugées « trop IA » ; la direction pop a été retravaillée et retenue.
4. **La matière : la mosaïque romaine.** « Chaque collaborateur est une tesselle ; ensemble, ils forment la parole de l'entreprise. » Les illustrations sont des mosaïques produites par `docs/marque/outils/mosaique.py` : tesselles décalées, tournées et nuancées comme posées à la main, joints sombres qui suivent la silhouette. Personnage : un buste d'orateur romain couronné de laurier, sa bulle de parole au-dessus de la tête.
5. **Le logo.** Une bulle de parole faite de 4 × 3 tesselles (pas 20, tesselle 17) et d'une queue inclinée. Une seule tesselle est jaune soleil : la voix de chacun, qui attend sa validation. En monochrome, elle devient une tesselle évidée. Le logotype est en Bagel Fat One, vectorisé.
6. **Les couleurs.** Rose `#DF1C60` (on agit), Soleil `#FFC93C` (ça attend), Vert-de-gris `#2BB59A` (c'est parti), Nuit `#1E1A45` (on lit), Marbre `#FFF4E2` (on respire). Le rose de la maquette (`#E5306F`) a été foncé pour que le texte blanc dessus atteigne 4,5:1 (4,7:1). Le bleu de LinkedIn est exclu.
7. **Les polices.** Bagel Fat One pour les titres, Schibsted Grotesk pour le texte, Caveat pour les notes manuscrites, sous licence OFL. Le site les héberge lui-même en woff2 (23 Ko, 38 Ko et 49 Ko, caractères latins ; Caveat n'est pas préchargée).
8. **Une seule source pour la géométrie.** Le logo, les fichiers fournis, les mosaïques, les éléments du site et la charte PDF sont produits par les scripts de `docs/marque/outils`. Le composant `Logo` du site est généré : ses couleurs sont des variables CSS, et il suit donc le mode sombre.

## Conséquences

- La charte (PDF de 32 pages), les logos (72 fichiers) et les illustrations sont destinés au Drive de Secutop, dossier « Rostra », à côté de « Les Employeurs ». Le dossier est créé ; l'envoi des fichiers a échoué le 20/11/2026, faute d'espace de stockage sur le compte Google. Ils ne sont pas dans le dépôt : `docs/marque/sortie/` est ignoré par Git et se régénère.
- L'application, les e-mails, le second facteur d'authentification (nom affiché dans l'application d'authentification), les métadonnées et le fichier llms.txt s'appellent désormais « Rostra ». Les codes de double authentification déjà enregistrés restent valides ; seul leur libellé change pour les nouvelles inscriptions.
- **Reste à faire par SimplX** : vérifier la disponibilité de la marque (INPI, EUIPO, classes 9, 35 et 42) et du nom de domaine, puis déposer la marque. Ces deux vérifications n'ont pas été faites ; elles conditionnent l'usage public du nom.

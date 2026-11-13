# 0006 – Visuels : modèles, rendu, photos et images générées

13 novembre 2026 · statut : adopté · incrément 1c (VIS-01 à VIS-05, VIS-08, VIS-11 à VIS-13, REC-18)

## Contexte

À l'incrément 1c, les visuels quittent l'outil actuel de Secutop (Canva, Higgsfield, tâche Claude) pour entrer dans le produit. Le cahier fixe :
- des modèles par espace et par compte, carrés ou portrait, à zones nommées (VIS-01), modifiables dans un éditeur simple avec aperçu en direct (VIS-02) ;
- le remplissage par l'IA et le rendu en PNG côté serveur (VIS-03) ;
- environ un visuel sur deux avec une image générée, réglable par compte (VIS-04) ;
- un générateur d'images sans personne identifiable, sans texte ni logo, avec un budget mensuel (VIS-05) ;
- une médiathèque où l'IA peut préférer une vraie photo (VIS-08) ;
- la mention « image générée par IA » (VIS-12) et le remplacement d'un visuel par le titulaire (VIS-13).

Deux risques dominent : un visuel illisible sur téléphone, ou présenté comme une vraie photo alors qu'il est généré ; et des coûts d'images qui dérivent.

## Décisions

1. **Rendu par une bibliothèque de dessin, pas par un navigateur.** Le cahier évoquait un navigateur sans tête (Playwright) ou Satori. Le rendu passe par `@napi-rs/canvas` (Skia), avec trois polices embarquées (licence OFL) au choix pour chaque zone de texte. Inter, linéale, est celle par défaut. Montserrat (géométrique) et Lora (à empattements) servent de police des titres de la charte. Ce choix apporte :
   - un seul module natif, sans navigateur à installer ni à maintenir sur le serveur ;
   - un rendu identique au pixel près entre le poste de développement, l'intégration continue et la production ;
   - le texte mesuré exactement : le moteur cherche la plus grande taille qui tient dans la zone, sans descendre sous la taille minimale ; au-delà, le texte est coupé avec « … » et le problème est signalé.

   Les espaces insécables du français sont posés au rendu : « : », « ? », « % » ne commencent pas une ligne, un nombre ou un mot d'une ou deux lettres ne la termine pas.
2. **Un modèle est une définition JSON validée.** Les zones (titre, sous-titre, 3 à 4 points, photo, logo, signature) sont dans `templates.definition`, pas dans une table `template_zones` : un modèle est toujours édité et rendu en entier. `parseTemplate` valide toute définition avant enregistrement et avant rendu, avec un message lisible. `has_photo` est une colonne calculée, utilisée par l'alternance.

   Quatre modèles de départ, aux couleurs de la charte, sont copiés dans l'espace à la première visite de qui gère le contenu, ou au premier visuel. Un modèle n'est jamais supprimé, il est archivé : les visuels rendus le citent.
3. **Le visuel d'un nouveau post est préparé avec lui.** Rédaction hebdomadaire, demande sans photo, reprise : le visuel est préparé juste après le texte et enregistré dans la même transaction que le post. Le post arrive donc « à valider » avec son visuel, conformément à la définition du statut « brouillon » (section 6.1).

   Une préparation asynchrone aurait laissé des posts en « brouillon », un statut qui ne tient pas son créneau (index `posts_one_per_slot`).

   Un incident de visuel ne bloque jamais le post. L'IA indisponible donne un visuel au titre repris du sujet ; une erreur inattendue donne un post sans visuel. Le rapport de rédaction le dit.
4. **Ordre de préparation :**
   1. L'IA lit le post (une donnée, GEN-13) et en tire un titre de 70 caractères au plus, un sous-titre facultatif, et 3 à 4 points de 45 caractères au plus. Quand le visuel porte une photo, elle choisit une photo de la médiathèque, seulement dans la liste fournie, ou décrit une scène à générer.
   2. La photo est générée si besoin, dans la limite du budget mensuel de l'espace et de deux images par post (RÈG-19). Sinon, le visuel devient un visuel texte et la raison est notée.
   3. Le modèle est choisi : ceux du compte s'il en a de ce genre, sinon ceux de l'espace. Un modèle à liste de points n'est pris que s'il y a des points. Le moins utilisé récemment par le compte passe en premier.
   4. Au plus deux modèles sont rendus, et le plus lisible est gardé (VIS-11 : texte coupé, contraste WCAG < 4,5, zone vide).
5. **Alternance décidée d'avance (VIS-04).** Pour chaque compte, les posts de la passe sont pris dans l'ordre chronologique. Chacun porte une photo si cela rapproche la part des visuels avec photo du réglage du compte (0, ¼, ½, ¾, 1), en tenant compte de ses 8 derniers visuels. À égalité, la photo l'emporte. La décision est une fonction pure (`photoTurns`), indépendante de l'ordre dans lequel les posts sont rédigés en parallèle.
6. **Transparence (VIS-12).** Une image générée est enregistrée comme telle (`kind = 'generated'`, `ai_generated`, générateur et consigne conservés). Un visuel qui en contient une est lui aussi marqué `ai_generated`. La page du post l'affiche (« Image générée par IA »).

   Le texte alternatif publié chez LinkedIn se termine par « Illustration générée par IA. ». Une photo de la médiathèque n'est jamais présentée comme générée, et inversement.
7. **Budget et coût (VIS-05, GEN-11).**
   - Le budget est un nombre d'images générées par mois civil, à l'heure de l'espace : 30 par défaut, réglé par le propriétaire ou un admin.
   - Chaque image compte dans le quota (RÈG-19) et son coût est enregistré dans `ai_usage`. Le remplissage du modèle par l'IA est compté à part (`purpose = 'visual'`).
   - Le budget est décompté avant l'appel au générateur : les visuels préparés en parallèle voient le même budget. Un appel en échec le rend.
8. **« Refaire le visuel » (VIS-13) passe par une file.**
   - Le titulaire ou l'équipe donne une consigne et choisit pour la photo : la garder, en changer, ou s'en passer. Sur un post sans visuel, la même demande en ajoute un.
   - La tâche `visuels` du worker la traite toutes les minutes. Elle prend un bail et fait trois essais ; une erreur est gardée pour être affichée. Le nouveau visuel prend la place de l'ancien.
   - Le droit et RÈG-07 sont appliqués au dépôt de la demande. Au moment d'enregistrer, le visuel n'est remplacé que si le post peut encore changer.
   - Une reprise « à modifier » refait le visuel avec les nouveaux mots, en gardant sa photo et son modèle (aucune nouvelle image).
9. **Générateur d'images derrière une interface.** `ImageGenerator` a trois réalisations :
   - simulée : développement, tests, démonstration ;
   - Higgsfield : connecteur écrit d'après la documentation publique de l'API ;
   - aucune : pas de génération, photo de la médiathèque ou visuel texte.

   Les règles de la scène (aucune personne identifiable, aucun texte, aucun logo ni marque réelle) sont ajoutées par le code à toute consigne, quelle que soit la description donnée par l'IA. Un refus de modération du fournisseur donne un visuel texte.
10. **Aperçu en direct sans rien enregistrer.** L'éditeur envoie le brouillon du formulaire au serveur, qui le rend avec des textes d'exemple et le logo de la charte. Rien n'est écrit ; l'accès est réservé aux membres de l'espace. Sans JavaScript, l'aperçu montre le modèle enregistré.

## Conséquences

- Le serveur web et le worker chargent un module natif (`@napi-rs/canvas`). Next.js le charge tel quel, sans l'empaqueter. Les fichiers de la police sont résolus à l'exécution, par Node.
- Les visuels texte et le choix du modèle ne coûtent qu'un appel court à l'IA (effort faible). Une image générée coûte le prix du fournisseur, dans la limite du budget.
- Un modèle de départ modifié garde ses modifications quand la charte change. La remise aux couleurs de la charte est une action explicite, qui les écrase.
- Une police de la charte qui n'est pas parmi les trois polices embarquées s'ajoute au paquet, si sa licence le permet. Les polices du client ne sont pas téléversées.
- Reporté : contrôle des défauts d'une image générée par un modèle de vision (VIS-11 : mains, visages, texte parasite), connecteur Canva (VIS-07), personnages de marque (VIS-06), carrousel PDF (VIS-10).

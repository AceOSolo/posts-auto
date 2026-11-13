# 0005 – Rédaction par l'IA : qui choisit, qui écrit, qui vérifie

13 novembre 2026 · statut : adopté · incrément 1b (GEN-01 à GEN-07, GEN-11 à GEN-13)

## Contexte

À l'incrément 1b, la rédaction hebdomadaire et les reprises quittent les tâches Claude programmées de Secutop pour entrer dans le produit. Le cahier fixe :
- l'ordre de priorité des sujets (GEN-02) ;
- la fenêtre glissante qui ne touche jamais un post décidé (GEN-03) ;
- l'interdiction d'inventer, avec des marqueurs bloquants (GEN-04) ;
- une vérification par un second passage indépendant (GEN-05) ;
- l'origine affichée de chaque post (GEN-06) ;
- les reprises (GEN-07) ;
- le coût mesuré (GEN-11) ;
- la transparence (GEN-12) ;
- les contenus externes traités comme des données (GEN-13).

Deux risques dominent : un post faux ou hors règles qui part sous le nom d'une personne, et un contenu externe (article, demande, post collé) qui détourne l'IA.

## Décisions

1. **Le code choisit les sujets, l'IA écrit.** Pour chaque compte et chaque semaine de la fenêtre, le code applique l'ordre de GEN-02. Il affecte un sujet à chaque créneau et calcule le créneau, avec les règles de 1a.

   Ordre : case du planning, événement à relayer, idée de l'équipe, ligne de la banque de sujets, réserve, puis autre matière.

   Cette affectation est une fonction pure de `@posts-auto/core`, testée sans IA. L'origine affichée (GEN-06) est donc un fait, pas une déclaration de l'IA.

   L'IA ne choisit un sujet qu'au rang 6 (« autre matière vérifiable »). Elle le choisit alors parmi des sources fournies : ligne éditoriale, état de l'offre, articles des sources externes.
2. **Remplacement d'un post « à valider » (GEN-03)** : seulement si une matière plus intéressante est **apparue** depuis la rédaction du post et n'a pas trouvé de créneau. Il faut à la fois :
   - un sujet de rang 1 à 4 (case, événement, idée de l'équipe, banque) ;
   - un rang strictement meilleur que celui du post ;
   - un sujet créé après le post.

   La réserve ne remplace jamais. Un sujet remis en circulation par un remplacement non plus, car il est plus ancien que les posts en place. Sans cette double règle, chaque remplacement en déclencherait un autre à la génération suivante.

   Ne sont jamais touchés :
   - les posts validés, publiés, refusés ou « à modifier » ;
   - les posts ponctuels (demande) ;
   - les posts dont le texte a été corrigé par une personne.

   Le sujet remplacé devient une idée « réserve » (IDE-02).
3. **Les cases du planning sont toujours rédigées.** Le rythme du compte (posts par semaine, posts en option) sert à compléter avec les autres sources ; il ne retire jamais un sujet planifié. Une case sans créneau libre dans sa semaine est signalée dans le rapport et dans l'inventaire (PLA-08).
4. **Deux passages, puis des contrôles déterministes.**
   - Le rédacteur produit le texte en sortie structurée (JSON validé).
   - Le vérificateur est un appel séparé, avec ses propres consignes. Il ne voit ni le raisonnement ni les consignes du rédacteur, et reçoit les mêmes sources. Il signale les faits non sourcés, les offres non disponibles et les écarts de ton.
   - Le code applique ensuite les règles mesurables : pas de `#`, pas de `@`, liens en fin de texte, longueur, phrases déjà publiées sur 8 semaines (RÈG-17).

   En cas d'écart, le rédacteur reçoit une seule fois la liste des problèmes. S'il en reste, le post est déposé avec un marqueur `[À VÉRIFIER : …]` qui bloque la publication : un problème n'est jamais caché au titulaire.
5. **Contenus externes = données (GEN-13).** Chaque contenu externe arrive dans un bloc `<document>` qui en donne la nature et la source. Les consignes système disent que ces blocs ne contiennent jamais d'instruction. Un détecteur déterministe repère les tournures d'injection (« ignore tes règles », « nouvelles instructions »…) et les inscrit au rapport de génération. Les contrôles de la décision 4 s'appliquent de toute façon : même une injection réussie ne peut pas faire publier un hashtag.
6. **Fournisseur.** Le paquet `@posts-auto/ai` expose une interface de modèle.
   - Implémentation réelle : SDK officiel Anthropic, sorties structurées validées par un schéma, mise en cache des consignes système stables, repli automatique en cas de refus.
   - Implémentation simulée, déterministe, pour les tests et le développement (`AI_MODE=fake`).

   Modèle par défaut : Claude Opus 5.5 pour la rédaction et la vérification, réglable par variable d'environnement (ADM-04). Chaque génération enregistre le modèle et la version des consignes (`generation_runs.model`, `prompt_version`).
7. **Coût mesuré à chaque appel (GEN-11).** Les jetons (entrée, sortie, cache) et le coût sont inscrits dans `ai_usage`, avec l'espace, le compte, le post et l'objet de l'appel. Un post généré compte dans le quota ; ses reprises non (RÈG-19).
8. **Pas de visuel à l'incrément 1b** : un post rédigé passe directement « à valider ». Il porte les photos d'une demande s'il en vient une. Les visuels arrivent à l'incrément 1c.
9. **Une seule génération à la fois par espace**, garantie par un bail en base, comme la file de publication : une génération interrompue est reprise au passage suivant. La génération repart toujours de l'état de la base. La relancer ne crée pas de doublon (REC-04).

10. **Sources de veille (GEN-09) sans ouvrir le réseau interne.** Un flux RSS est une adresse saisie par un client et lue par nos serveurs : c'est une porte classique vers le réseau interne de l'hébergement (SSRF). La relève n'accepte que http et https, sur les ports 80 et 443, sans identifiants dans l'adresse. L'adresse IP contrôlée est celle de la connexion elle-même, par le résolveur d'undici, et ce à chaque redirection (3 au plus) : un nom qui changerait d'adresse entre deux résolutions est refusé aussi. Limites : 2 Mo et 10 secondes. Le lecteur XML ne résout aucune entité externe. Chaque créneau laissé au choix de l'IA reçoit un article différent. Si l'IA le reprend, le post a l'origine « source externe » et l'article ne resert pas.

## Conséquences

- Les tests de l'affectation et des contrôles n'ont besoin ni de réseau ni de clé.
- La qualité des textes dépend des consignes. Elles sont versionnées dans le dépôt (`packages/ai/src/prompts/`) et testées sur un jeu d'exemples avant chaque changement.
- Sans clé Anthropic (`ANTHROPIC_API_KEY`), l'application fonctionne en mode simulé : les textes sont des gabarits, clairement marqués comme tels.

# Marque Rostra

Charte graphique v1.0 (novembre 2026). Décision : [0009 – Nom et identité visuelle](../decisions/0009-marque-rostra.md).

La charte en PDF et les logos vont sur le Drive de Secutop, dans le dossier « Rostra ». Ce dossier-ci contient de quoi les régénérer.

## Contenu

| Chemin | Rôle |
| --- | --- |
| `outils/geom.py` | Géométrie de la bulle en tesselles (grille de 20) et vectorisation du logotype en Bagel Fat One |
| `outils/compose.py` | Versions du logo (horizontal, vertical, symbole, logotype) et leurs 4 couleurs |
| `outils/mosaique.py` | Transforme un dessin en aplats en mosaïque de tesselles posées « à la main » |
| `outils/exporter_illustrations.py` | Mosaïques de `illustrations/` (buste, pictogrammes des étapes) pour le site et les supports |
| `outils/exporter_logos.py` | Fichiers fournis : SVG, PNG, JPEG, avatars, dans `sortie/Rostra/Logos` |
| `outils/exporter_site.py` | Fichiers du site : `components/logo.tsx`, `icon.svg`, `apple-icon.png`, `opengraph-image.png`, `public/marque` |
| `outils/charte.py` | Charte en PDF (A4 paysage), dans `sortie/Rostra` |
| `illustrations/` | Dessins en aplats, sources des mosaïques |
| `polices/` | Bagel Fat One, Schibsted Grotesk et Caveat (licence SIL OFL 1.1) |
| `sortie/` | Fichiers produits, ignorés par Git |

## Régénérer

Prérequis : Python 3.12 avec fontTools, Pillow et Playwright, et Google Chrome.

```sh
cd docs/marque/outils
python exporter_logos.py          # logos
python exporter_illustrations.py  # mosaïques
python exporter_site.py           # fichiers du site
python charte.py           # charte PDF (avec des captures du site dans sortie/captures)
```

Toute modification du logo se fait dans `geom.py` ou `compose.py`, toute illustration dans `illustrations/`, puis on relance les scripts. On ne retouche jamais les fichiers produits à la main.

Les polices du site (`apps/web/public/fonts`) sont des sous-ensembles latins en woff2, tirés des fichiers de `polices/` avec fontTools : Bagel Fat One telle quelle, Schibsted Grotesk de 400 à 700, Caveat en 600.

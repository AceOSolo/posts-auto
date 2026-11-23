# Mise en production

Un serveur (VPS) hébergé dans l'Union européenne, avec Docker. Tout tient dans `deploy/` :

| Service | Rôle |
| --- | --- |
| `postgres` | Base PostgreSQL 16, non exposée sur Internet |
| `migrate` | Applique les migrations à chaque démarrage, avant le reste |
| `web` | Application et site vitrine (Next.js), port 3000 en interne |
| `worker` | Tâches de fond : publication, rédaction, rappels, facturation, statistiques… |
| `caddy` | HTTPS automatique (Let's Encrypt), ports 80 et 443 |
| `backup` | Sauvegarde chaque nuit de la base et des médias, 14 jours gardés |

L'image est construite et publiée par l'intégration continue à chaque envoi réussi sur `main` : `ghcr.io/aceosolo/posts-auto:latest`, et une étiquette par commit. Ce montage a été essayé localement : migrations, page de santé, rendu des visuels dans le conteneur, sauvegarde puis restauration.

## 1. Serveur

- **Taille** : 2 vCPU, 4 Go de mémoire et 40 Go de disque suffisent pour les premiers clients. Prendre un hébergeur dans l'UE : Scaleway, OVHcloud ou Hetzner (Allemagne, Finlande), par exemple.
- **Logiciels** : Docker et le plugin Compose.
- **Pare-feu** : seuls les ports 22, 80 et 443 sont ouverts.
- **DNS** : un enregistrement A (et AAAA) de `app.<domaine>` vers le serveur, et `www.` si besoin.

## 2. Configuration

```sh
git clone https://github.com/AceOSolo/posts-auto.git && cd posts-auto/deploy
cp .env.production.example .env
openssl rand -base64 32   # POSTGRES_PASSWORD
openssl rand -base64 32   # clé de TOKEN_ENCRYPTION_KEYS (« k1:<clé> »)
```

Compléter `.env` : domaine, clés des services, `MAIL_FROM`… La clé de chiffrement est à conserver aussi **hors du serveur**, dans un gestionnaire de mots de passe. Sans elle, les connexions LinkedIn et Canva enregistrées ne peuvent plus être lues.

Si le dépôt ou l'image est privé, se connecter au registre avant le premier démarrage : `docker login ghcr.io`, avec un jeton GitHub qui a le droit `read:packages`. Sinon, construire l'image sur le serveur : `docker compose -f compose.prod.yaml build`.

## 3. Démarrage

```sh
docker compose -f compose.prod.yaml pull
docker compose -f compose.prod.yaml up -d
docker compose -f compose.prod.yaml logs -f migrate web worker
curl https://app.<domaine>/sante
```

Accès au back-office pour l'équipe SimplX. La personne crée d'abord son compte par l'inscription, puis :

```sh
docker compose -f compose.prod.yaml run --rm web admin-add prenom.nom@simplx.fr
```

## 4. Mises à jour

```sh
docker compose -f compose.prod.yaml pull && docker compose -f compose.prod.yaml up -d
```

Les migrations passent avant le redémarrage du web et des tâches de fond. Revenir en arrière : `IMAGE=ghcr.io/aceosolo/posts-auto:<commit>` dans `.env`, puis `up -d`.

**Attention** : une migration n'est jamais annulée automatiquement. Avant une mise à jour qui en contient, faire une sauvegarde immédiate (voir ci-dessous).

## 5. Sauvegardes et restauration

- **Chaque nuit** (`BACKUP_HOUR`, heure UTC) : `base-<date>.dump` (pg_dump) et `medias-<date>.tar.gz` dans le volume `backups`.
- **Tout de suite** : `docker compose -f compose.prod.yaml exec backup sh /usr/local/bin/sauvegarde.sh now`
- **Copie hors du serveur, indispensable** : synchroniser chaque jour le volume `backups` vers un stockage objet d'une autre région, ou activer les instantanés de disque de l'hébergeur. Exemple avec rclone sur le serveur (tâche cron) :
  `rclone sync /var/lib/docker/volumes/rostra_backups/_data distant:rostra-sauvegardes`.
- **Restauration** de la base :
  ```sh
  docker compose -f compose.prod.yaml stop web worker
  docker compose -f compose.prod.yaml exec backup sh -c 'pg_restore --clean --if-exists --no-owner -d "$PGDATABASE" /backups/base-<date>.dump'
  docker compose -f compose.prod.yaml start web worker
  ```
- **Restauration** des médias : extraire l'archive dans le volume `media`.
- **Essai de restauration** : une fois par trimestre, dans une base à part (`createdb restauration_essai`), pour s'assurer que les sauvegardes sont lisibles.

## 6. Supervision

- **Disponibilité** : surveiller `https://app.<domaine>/sante` toutes les minutes depuis l'extérieur, par exemple avec UptimeRobot ou Better Stack. Alerter par e-mail ou SMS.
- **Journaux** : web, worker et Caddy écrivent une ligne JSON par événement, à lire avec `docker compose logs`. Surveiller en particulier les événements `tache.echec` des tâches de fond et `sauvegarde_en_echec`.
- **Fonctionnement** : la page « Supervision » du back-office montre les files de travail, les erreurs LinkedIn, les connexions qui expirent et les coûts de l'IA.

## 7. Services externes à configurer

| Service | Où | Adresses de retour et webhooks |
| --- | --- | --- |
| LinkedIn | Application développeur (Community Management API) | `https://app.<domaine>/comptes/connecter/retour` |
| Stripe | Clés live, produits et prix, Stripe Tax, portail client | Webhook `https://app.<domaine>/api/stripe/webhook` (décision 0007) |
| Brevo | Domaine d'envoi authentifié (SPF, DKIM, DMARC) | — |
| Brevo, réception (facultatif, IDE-07) | Sous-domaine de réception distinct de l'envoi, par exemple `idees.<domaine>`, avec deux enregistrements MX : priorité 10 `inbound1.sendinblue.com.`, priorité 20 `inbound2.sendinblue.com.`. Définir `INBOUND_EMAIL_DOMAIN`, `INBOUND_EMAIL_SECRET` et `INBOUND_EMAIL_WEBHOOK_SECRET`. | Webhook de type `inbound`, événement `inboundEmailProcessed` : `https://app.<domaine>/api/email-entrant/<INBOUND_EMAIL_WEBHOOK_SECRET>` |
| Anthropic | Clé d'API, plafond de dépenses | — |
| Google (facultatif) | Client OAuth « Application Web » | `https://app.<domaine>/connexion/sso/google/retour` |
| Microsoft (facultatif) | Application Entra ID, revendications `email` et `xms_edov` | `https://app.<domaine>/connexion/sso/microsoft/retour` |
| Canva (facultatif) | Intégration Canva Connect | `https://app.<domaine>/visuels/canva/retour` |

Une fois les clés en place, `docker compose -f compose.prod.yaml run --rm worker verifier-integrations` vérifie chaque service, sans rien publier : voir `docs/recette-integrations.md`.

-- File de publication (PUB-01 à PUB-04).
--
-- Le post est sa propre entrée de file : statut « en_publication » + prochaine tentative.
-- Un verrou à durée limitée (publish_lease_until) empêche deux processus de publier le
-- même post ; s'il expire alors qu'une tentative n'est pas terminée, l'issue est
-- incertaine et le post passe en erreur sans nouvel essai automatique.

ALTER TABLE posts
  ADD COLUMN publish_retries_left    int NOT NULL DEFAULT 3 CHECK (publish_retries_left BETWEEN 0 AND 3),
  ADD COLUMN next_publish_attempt_at timestamptz,
  ADD COLUMN publish_lease_until     timestamptz;

CREATE INDEX posts_publication_queue_idx ON posts (next_publish_attempt_at) WHERE status = 'en_publication';

-- Résultat de chaque tentative : publié, sûrement pas créé, ou incertain.
ALTER TABLE publish_attempts
  ADD COLUMN outcome text CHECK (outcome IN ('published', 'not_created', 'unknown'));
-- Une seule tentative en cours par post.
CREATE UNIQUE INDEX publish_attempts_one_running_idx ON publish_attempts (post_id) WHERE finished_at IS NULL;

-- L'API Images de LinkedIn n'accepte que JPG, GIF et PNG : le WebP est converti à l'envoi.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_mime_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_mime_check
  CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif'));

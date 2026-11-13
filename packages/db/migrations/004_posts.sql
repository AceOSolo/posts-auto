-- Médias et posts (sections 5.8 à 5.10, 6 et 7).

CREATE TABLE media_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('upload', 'generated', 'rendered', 'canva_export')),
  storage_key  text NOT NULL UNIQUE,
  mime         text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  width        int CHECK (width > 0),
  height       int CHECK (height > 0),
  bytes        int CHECK (bytes > 0 AND bytes <= 10485760), -- SEC-07 : 10 Mo au plus par image
  ai_generated boolean NOT NULL DEFAULT false,
  generator    text,
  prompt       text,
  template_id  uuid, -- clé étrangère ajoutée avec les modèles (incrément 1c)
  tags         text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CHECK (kind <> 'generated' OR ai_generated) -- VIS-12 : une image générée est toujours marquée comme telle
);
CREATE INDEX media_assets_workspace_idx ON media_assets (workspace_id);

CREATE TABLE posts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  account_id            uuid NOT NULL,
  week_start            date NOT NULL CHECK (extract(isodow FROM week_start) = 1), -- lundi de la semaine ISO
  scheduled_at          timestamptz NOT NULL,
  original_scheduled_at timestamptz,
  reschedule_count      int NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  -- RÈG-11 : date limite d'un post lié à un événement ; il ne part jamais après.
  must_publish_by       timestamptz,
  is_optional           boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'brouillon' CHECK (status IN (
                          'brouillon', 'a_valider', 'modif', 'refuse', 'valide',
                          'en_publication', 'publie', 'erreur', 'remplace', 'abandonne')),
  current_version_id    uuid,
  origin                text NOT NULL CHECK (origin IN (
                          'planning', 'event', 'team_idea', 'ai_idea', 'ai_reserve', 'request', 'external_source')),
  -- Liens vers le planning, les idées et les demandes : clés étrangères ajoutées à l'incrément 1b.
  planning_cell_id      uuid,
  subject_id            uuid,
  idea_id               uuid,
  request_id            uuid,
  generation_run_id     uuid,
  source_note           text,
  -- PUB-10 : référence fournie par l'API d'échange, rend la création idempotente.
  external_ref          text,
  replaces_post_id      uuid,
  version_no            int NOT NULL DEFAULT 1 CHECK (version_no >= 1),
  motif                 text,
  decided_by            uuid REFERENCES users ON DELETE SET NULL,
  decided_at            timestamptz,
  decided_as_delegate   boolean,
  decision_note         text,
  published_at          timestamptz,
  external_post_urn     text,
  external_post_url     text,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id),
  FOREIGN KEY (replaces_post_id, workspace_id) REFERENCES posts (id, workspace_id),
  CHECK (status <> 'publie' OR (published_at IS NOT NULL AND external_post_urn IS NOT NULL))
);
-- RÈG-03 : deux posts d'un même compte ne partagent pas un créneau.
CREATE UNIQUE INDEX posts_one_per_slot_idx ON posts (account_id, scheduled_at)
  WHERE status IN ('a_valider', 'valide', 'en_publication', 'publie');
CREATE UNIQUE INDEX posts_external_ref_idx ON posts (workspace_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX posts_workspace_schedule_idx ON posts (workspace_id, scheduled_at);
-- Tâches de fond : posts à publier ou à replanifier.
CREATE INDEX posts_pending_idx ON posts (scheduled_at) WHERE status IN ('a_valider', 'valide', 'erreur');

-- Révisions du texte d'un post (GEN-07 : une révision corrige le texte d'un même post).
CREATE TABLE post_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL,
  post_id              uuid NOT NULL,
  revision             int NOT NULL CHECK (revision >= 1),
  body                 text NOT NULL CHECK (length(body) <= 3000), -- limite LinkedIn : 3 000 caractères
  author_kind          text NOT NULL CHECK (author_kind IN ('ai', 'user')),
  author_user_id       uuid REFERENCES users ON DELETE SET NULL,
  -- VAL-03 : même détection que hasBlockingMarkers() de @posts-auto/core (vérifié par les tests).
  -- Variantes accentuées écrites en clair : la casse des lettres accentuées dépend de la locale.
  has_blocking_markers boolean GENERATED ALWAYS AS (
                         body ~* '\[[[:space:]]*[ÀàAa][[:space:]]+(compl[ÉéEe]ter|v[ÉéEe]rifier)'
                       ) STORED,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, revision),
  UNIQUE (id, post_id),
  FOREIGN KEY (post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE CASCADE
);

-- La version courante appartient forcément au post (contrôle en fin de transaction).
ALTER TABLE posts ADD CONSTRAINT posts_current_version_fk
  FOREIGN KEY (current_version_id, id) REFERENCES post_versions (id, post_id) DEFERRABLE INITIALLY DEFERRED;

-- VIS-09 : jusqu'à 9 images, la n°1 étant la couverture ; ordre modifiable dans une transaction.
CREATE TABLE post_media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  post_id      uuid NOT NULL,
  position     int NOT NULL CHECK (position BETWEEN 1 AND 9),
  asset_id     uuid NOT NULL,
  alt_text     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_media_position_key UNIQUE (post_id, position) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (post_id, asset_id),
  FOREIGN KEY (post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, workspace_id) REFERENCES media_assets (id, workspace_id)
);

-- Toute transition est enregistrée (section 6.1). Table en ajout seul pour app_web.
CREATE TABLE post_status_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  post_id       uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('system', 'user')),
  actor_user_id uuid REFERENCES users ON DELETE SET NULL,
  reason        text,
  at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX post_status_history_post_idx ON post_status_history (post_id, at);

-- PUB-03 : une tentative par clé d'unicité ; un post n'est publié qu'une fois.
CREATE TABLE publish_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  post_id         uuid NOT NULL,
  attempt         int NOT NULL CHECK (attempt >= 1),
  idempotency_key text NOT NULL UNIQUE,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  http_status     int,
  error_code      text,
  error_message   text,
  UNIQUE (post_id, attempt),
  FOREIGN KEY (post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE CASCADE
);

CREATE TRIGGER media_assets_touch BEFORE UPDATE ON media_assets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER posts_touch BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

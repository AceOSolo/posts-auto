-- Planning, banque de sujets, événements (section 5.5), idées et demandes de post (section 5.6).
-- Les listes d'identifiants du schéma de la v1.1 (uuid[]) deviennent des tables de
-- liaison, pour l'intégrité référentielle (règles du schéma, section 7).

-- PLA-03 : banque de sujets (onglets « Edito LK »), par compte ou commune à l'espace.
CREATE TABLE subject_bank (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  account_id   uuid,
  position     int NOT NULL DEFAULT 0,
  subject      text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 500),
  theme        text,
  angle        text,
  format       text,
  offer        text,
  audience     text,
  -- Coché quand un post issu de ce sujet est publié.
  published    boolean NOT NULL DEFAULT false,
  -- Référence dans le fichier importé (onglet et ligne), pour la synchronisation (PLA-06).
  source_ref   text,
  created_by   uuid REFERENCES users ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX subject_bank_account_idx ON subject_bank (workspace_id, account_id, position);
CREATE TRIGGER subject_bank_touch BEFORE UPDATE ON subject_bank FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- PLA-01, PLA-02 : planning comptes × semaines. Une ligne par sujet : une case (ligne du
-- planning, semaine) peut contenir plusieurs sujets, rangés par `position`. L'état affiché
-- (prévu, rédigé, validé, publié) se calcule à partir des posts issus du sujet ; seul
-- « mis de côté » est une décision enregistrée.
CREATE TABLE planning_cells (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  row_kind         text NOT NULL CHECK (row_kind IN ('account', 'event', 'channel')),
  account_id       uuid,
  row_label        text,
  week_start       date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  position         int NOT NULL DEFAULT 1 CHECK (position >= 1),
  content          text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 500),
  subject_id       uuid,
  set_aside_at     timestamptz,
  set_aside_reason text,
  source_ref       text,
  created_by       uuid REFERENCES users ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE NULLS NOT DISTINCT (workspace_id, row_kind, account_id, row_label, week_start, position),
  -- Une ligne « compte » désigne un compte ; les autres lignes portent un libellé.
  CHECK ((row_kind = 'account') = (account_id IS NOT NULL)),
  CHECK (row_kind = 'account' OR coalesce(btrim(row_label), '') <> ''),
  CHECK ((set_aside_at IS NULL) = (set_aside_reason IS NULL)),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, workspace_id) REFERENCES subject_bank (id, workspace_id) ON DELETE SET NULL (subject_id)
);
CREATE INDEX planning_cells_week_idx ON planning_cells (workspace_id, week_start);
CREATE TRIGGER planning_cells_touch BEFORE UPDATE ON planning_cells FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- PLA-04 : événements datés, relayés sur les comptes choisis dans les 3 semaines qui précèdent.
CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  title        text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  starts_on    date NOT NULL,
  ends_on      date,
  link         text,
  details      text,
  created_by   uuid REFERENCES users ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX events_workspace_idx ON events (workspace_id, starts_on);
CREATE TRIGGER events_touch BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE event_accounts (
  event_id     uuid NOT NULL,
  account_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (event_id, account_id),
  FOREIGN KEY (event_id, workspace_id) REFERENCES events (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);

-- IDE-01, IDE-02 : idées de l'équipe et réserve de l'IA.
CREATE TABLE ideas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  title         text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  details       text,
  link          text,
  -- Période où l'idée est pertinente, et date d'un événement lié.
  starts_on     date,
  ends_on       date,
  event_on      date,
  all_accounts  boolean NOT NULL DEFAULT false,
  origin        text NOT NULL CHECK (origin IN ('team', 'ai_reserve')),
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'kept', 'used', 'dismissed')),
  target_week   date CHECK (target_week IS NULL OR extract(isodow FROM target_week) = 1),
  -- Suivi écrit par l'IA (ce qui a été fait de l'idée, et pourquoi).
  followup      text,
  -- Réserve : post dont le sujet a été remplacé par un meilleur (GEN-03).
  from_post_id  uuid,
  created_by    uuid REFERENCES users ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX ideas_workspace_idx ON ideas (workspace_id, status);
CREATE TRIGGER ideas_touch BEFORE UPDATE ON ideas FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE idea_accounts (
  idea_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (idea_id, account_id),
  FOREIGN KEY (idea_id, workspace_id) REFERENCES ideas (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);

-- IDE-03 à IDE-06 : demandes de post, traitées dans l'heure.
CREATE TABLE post_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  raw_text     text CHECK (length(raw_text) <= 5000),
  title        text,
  details      text CHECK (length(details) <= 5000),
  links        text[] NOT NULL DEFAULT '{}',
  wished_at    timestamptz,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'done', 'impossible')),
  -- Suivi visible du demandeur (IDE-06).
  followup     text,
  attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until  timestamptz,
  last_error   text,
  processed_at timestamptz,
  created_by   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CHECK (coalesce(btrim(raw_text), '') <> '' OR coalesce(btrim(details), '') <> '')
);
CREATE INDEX post_requests_pending_idx ON post_requests (created_at) WHERE status IN ('new', 'in_progress');
CREATE TRIGGER post_requests_touch BEFORE UPDATE ON post_requests FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE request_accounts (
  request_id   uuid NOT NULL,
  account_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (request_id, account_id),
  FOREIGN KEY (request_id, workspace_id) REFERENCES post_requests (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);

-- Photos de la demande, dans l'ordre choisi ; la n°1 est le visuel principal. Au plus 9 :
-- c'est le maximum d'images d'un post (VIS-09) ; le « 10 » d'IDE-03 est corrigé dans le cahier.
CREATE TABLE request_photos (
  request_id   uuid NOT NULL,
  asset_id     uuid NOT NULL,
  workspace_id uuid NOT NULL,
  position     int NOT NULL CHECK (position BETWEEN 1 AND 9),
  PRIMARY KEY (request_id, asset_id),
  CONSTRAINT request_photos_position_key UNIQUE (request_id, position) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (request_id, workspace_id) REFERENCES post_requests (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, workspace_id) REFERENCES media_assets (id, workspace_id) DEFERRABLE INITIALLY DEFERRED
);

-- Liens des posts vers leur source (GEN-06, PLA-07). Reportables : la suppression d'un
-- espace efface en cascade les posts et leurs sources dans la même instruction.
ALTER TABLE posts
  ADD CONSTRAINT posts_planning_cell_fk FOREIGN KEY (planning_cell_id, workspace_id)
    REFERENCES planning_cells (id, workspace_id) ON DELETE SET NULL (planning_cell_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT posts_subject_fk FOREIGN KEY (subject_id, workspace_id)
    REFERENCES subject_bank (id, workspace_id) ON DELETE SET NULL (subject_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT posts_idea_fk FOREIGN KEY (idea_id, workspace_id)
    REFERENCES ideas (id, workspace_id) ON DELETE SET NULL (idea_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT posts_request_fk FOREIGN KEY (request_id, workspace_id)
    REFERENCES post_requests (id, workspace_id) ON DELETE SET NULL (request_id) DEFERRABLE INITIALLY DEFERRED;
-- Un post d'événement porte l'événement qu'il relaie (PLA-04).
ALTER TABLE posts ADD COLUMN event_id uuid,
  ADD CONSTRAINT posts_event_fk FOREIGN KEY (event_id, workspace_id)
    REFERENCES events (id, workspace_id) ON DELETE SET NULL (event_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX posts_planning_cell_idx ON posts (planning_cell_id) WHERE planning_cell_id IS NOT NULL;
CREATE INDEX posts_idea_idx ON posts (idea_id) WHERE idea_id IS NOT NULL;
CREATE INDEX posts_request_idx ON posts (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX posts_event_idx ON posts (event_id) WHERE event_id IS NOT NULL;

ALTER TABLE ideas ADD CONSTRAINT ideas_from_post_fk FOREIGN KEY (from_post_id, workspace_id)
  REFERENCES posts (id, workspace_id) ON DELETE SET NULL (from_post_id) DEFERRABLE INITIALLY DEFERRED;

SELECT app.protect_workspace_table('subject_bank', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('planning_cells', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('events', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('event_accounts', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('ideas', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('idea_accounts', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('post_requests', 'SELECT, INSERT, UPDATE');
SELECT app.protect_workspace_table('request_accounts', 'SELECT, INSERT, DELETE');
SELECT app.protect_workspace_table('request_photos', 'SELECT, INSERT, UPDATE, DELETE');

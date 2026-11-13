-- Générations par l'IA, coût mesuré et signalements (section 5.7, GEN-01 à GEN-13).

-- GEN-01, GEN-05 : une génération (hebdomadaire, demande, reprise, à la demande) et son
-- rapport (sujets retenus, remplacés, écarts trouvés par la vérification, consignes
-- suspectes repérées dans les contenus externes).
CREATE TABLE generation_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('weekly', 'request', 'rework', 'on_demand')),
  weeks          date[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  -- Bail : une génération interrompue est reprise quand il expire (décision 0005).
  lease_until    timestamptz,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  report         jsonb NOT NULL DEFAULT '{}',
  model          text,
  prompt_version text,
  triggered_by   uuid REFERENCES users ON DELETE SET NULL,
  error          text,
  UNIQUE (id, workspace_id),
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX generation_runs_workspace_idx ON generation_runs (workspace_id, started_at DESC);
-- Une seule génération hebdomadaire en cours par espace.
CREATE UNIQUE INDEX generation_runs_one_weekly_idx ON generation_runs (workspace_id) WHERE status = 'running' AND kind = 'weekly';

ALTER TABLE posts ADD CONSTRAINT posts_generation_run_fk FOREIGN KEY (generation_run_id, workspace_id)
  REFERENCES generation_runs (id, workspace_id) ON DELETE SET NULL (generation_run_id) DEFERRABLE INITIALLY DEFERRED;

-- GEN-11 : coût de chaque appel à un fournisseur d'IA, par espace et par compte.
CREATE TABLE ai_usage (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  account_id         uuid,
  run_id             uuid,
  post_id            uuid,
  provider           text NOT NULL,
  model              text NOT NULL,
  purpose            text NOT NULL CHECK (purpose IN ('write', 'verify', 'rewrite', 'rework', 'interpret', 'learn', 'image')),
  kind               text NOT NULL CHECK (kind IN ('text', 'image')),
  input_tokens       int NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      int NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  int NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens int NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  -- Images générées (incrément 1c).
  units              int NOT NULL DEFAULT 0 CHECK (units >= 0),
  cost_usd           numeric(12, 6) NOT NULL DEFAULT 0,
  cost_eur           numeric(12, 6) NOT NULL DEFAULT 0,
  -- RÈG-19 : un post généré compte dans le quota, ses reprises non.
  counted_in_quota   boolean NOT NULL DEFAULT false,
  at                 timestamptz NOT NULL DEFAULT now(),
  -- Pas de clé étrangère vers le compte ni le post : le coût reste compté après leur suppression.
  FOREIGN KEY (run_id, workspace_id) REFERENCES generation_runs (id, workspace_id) ON DELETE SET NULL (run_id)
);
CREATE INDEX ai_usage_workspace_idx ON ai_usage (workspace_id, at);

-- GEN-12 : « Signaler un contenu » sur chaque post, traité par l'éditeur du produit.
CREATE TABLE content_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  post_id      uuid NOT NULL,
  reported_by  uuid REFERENCES users ON DELETE SET NULL,
  reason       text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  handled_at   timestamptz,
  handler_note text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX content_reports_open_idx ON content_reports (created_at) WHERE status = 'open';

-- Écrites par le système ; lisibles par l'espace. Les signalements sont créés par les membres.
SELECT app.protect_workspace_table('generation_runs', 'SELECT');
SELECT app.protect_workspace_table('ai_usage', 'SELECT');
SELECT app.protect_workspace_table('content_reports', 'SELECT, INSERT');
GRANT USAGE, SELECT ON SEQUENCE ai_usage_id_seq TO app_worker;

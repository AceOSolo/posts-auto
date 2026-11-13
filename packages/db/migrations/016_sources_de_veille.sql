-- Sources externes de l'espace (GEN-09) : flux RSS ou Atom (blog de l'entreprise, veille
-- réglementaire…). L'IA peut en tirer des posts en citant le lien. Leur contenu est une
-- donnée, jamais une consigne (GEN-13, REC-17).

CREATE TABLE content_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'rss' CHECK (kind IN ('rss')),
  url             text NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 1000),
  label           text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  enabled         boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_error      text,
  created_by      uuid REFERENCES users ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, url)
);
CREATE TRIGGER content_sources_touch BEFORE UPDATE ON content_sources FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE source_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_id    uuid NOT NULL,
  -- Identifiant de l'article dans le flux (guid, id, ou à défaut le lien).
  guid         text NOT NULL CHECK (length(guid) <= 1000),
  title        text NOT NULL CHECK (length(title) <= 500),
  link         text CHECK (link ~ '^https?://' AND length(link) <= 1000),
  summary      text CHECK (length(summary) <= 5000),
  published_at timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  -- Post qui a repris l'article (un article ne sert qu'une fois).
  used_post_id uuid,
  UNIQUE (source_id, guid),
  FOREIGN KEY (source_id, workspace_id) REFERENCES content_sources (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (used_post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE SET NULL (used_post_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX source_items_unused_idx ON source_items (workspace_id, published_at DESC) WHERE used_post_id IS NULL;

SELECT app.protect_workspace_table('content_sources', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('source_items', 'SELECT');

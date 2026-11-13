-- Incrément 1c : visuels (VIS-01 à VIS-13).

-- VIS-01, VIS-02 : modèles de l'espace, ou réservés à un compte. Les zones sont dans la
-- définition (format TemplateDefinition de @posts-auto/visuals, validé avant tout
-- enregistrement) plutôt que dans une table template_zones : un modèle est toujours
-- édité et rendu en entier, aucune requête ne porte sur une zone seule.
CREATE TABLE templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  account_id   uuid,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  format       text NOT NULL CHECK (format IN ('square', 'portrait')),
  definition   jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND definition ->> 'format' = format),
  -- VIS-04 : modèle avec photo (image générée ou photo réelle) ou visuel texte.
  has_photo    boolean GENERATED ALWAYS AS (coalesce(definition -> 'zones' @> '[{"kind": "photo"}]', false)) STORED,
  -- Modèle de départ dont il est la copie (galerie intégrée).
  gallery_key  text,
  -- Un modèle n'est jamais supprimé (les visuels rendus le citent) : il est archivé.
  archived_at  timestamptz,
  created_by   uuid REFERENCES users ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX templates_workspace_idx ON templates (workspace_id) WHERE archived_at IS NULL;
-- Une seule copie de chaque modèle de départ par espace.
CREATE UNIQUE INDEX templates_gallery_idx ON templates (workspace_id, gallery_key) WHERE gallery_key IS NOT NULL AND account_id IS NULL;
CREATE TRIGGER templates_touch BEFORE UPDATE ON templates FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- VIS-08 : médiathèque des photos de l'entreprise (dossier, mots-clés, nom).
-- VIS-03, VIS-13 : un visuel rendu garde sa recette (modèle, textes, photo utilisée) pour
-- pouvoir être refait.
ALTER TABLE media_assets
  ADD COLUMN in_library      boolean NOT NULL DEFAULT false,
  ADD COLUMN label           text CHECK (label IS NULL OR length(label) <= 120),
  ADD COLUMN folder          text CHECK (folder IS NULL OR length(btrim(folder)) BETWEEN 1 AND 60),
  ADD COLUMN uploaded_by     uuid REFERENCES users ON DELETE SET NULL,
  ADD COLUMN source_asset_id uuid,
  ADD COLUMN render_content  jsonb,
  ADD CONSTRAINT media_assets_template_fk FOREIGN KEY (template_id, workspace_id)
    REFERENCES templates (id, workspace_id) ON DELETE SET NULL (template_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT media_assets_source_fk FOREIGN KEY (source_asset_id, workspace_id)
    REFERENCES media_assets (id, workspace_id) ON DELETE SET NULL (source_asset_id) DEFERRABLE INITIALLY DEFERRED,
  -- Seules des photos entrent dans la médiathèque, jamais un visuel rendu.
  ADD CONSTRAINT media_assets_library_check CHECK (NOT in_library OR kind IN ('upload', 'generated')),
  ADD CONSTRAINT media_assets_render_check CHECK (render_content IS NULL OR (kind = 'rendered' AND jsonb_typeof(render_content) = 'object'));
CREATE INDEX media_assets_library_idx ON media_assets (workspace_id, folder) WHERE in_library;

-- VIS-03, VIS-13 : visuels à préparer, traités par la tâche « visuels » du worker.
--   new     : post rédigé par l'IA sans image ;
--   refresh : texte du post repris par l'IA, le visuel rendu reprend les nouveaux mots ;
--   redo    : « refaire le visuel » demandé par un membre, avec une consigne.
CREATE TABLE visual_tasks (
  post_id      uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('new', 'refresh', 'redo')),
  instruction  text CHECK (instruction IS NULL OR length(instruction) <= 1000),
  new_photo    boolean NOT NULL DEFAULT false,
  requested_by uuid REFERENCES users ON DELETE SET NULL,
  attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until  timestamptz,
  failed_at    timestamptz,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX visual_tasks_due_idx ON visual_tasks (created_at) WHERE failed_at IS NULL;

-- VIS-05 : budget d'images générées par mois civil (fuseau de l'espace). Au-delà, le
-- visuel prend une photo de la médiathèque ou devient un visuel texte.
ALTER TABLE workspaces ADD COLUMN image_budget_monthly int NOT NULL DEFAULT 30 CHECK (image_budget_monthly BETWEEN 0 AND 1000);

-- VIS-03 : remplissage d'un modèle par l'IA, compté à part.
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check
  CHECK (purpose IN ('write', 'verify', 'rewrite', 'rework', 'interpret', 'learn', 'image', 'visual'));
CREATE INDEX ai_usage_images_idx ON ai_usage (workspace_id, at) WHERE kind = 'image';

SELECT app.protect_workspace_table('templates', 'SELECT, INSERT, UPDATE');
SELECT app.protect_workspace_table('visual_tasks', 'SELECT, INSERT, UPDATE, DELETE');

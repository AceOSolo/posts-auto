-- Ligne éditoriale, état de l'offre, exemples et préférences apprises (section 5.4, EDI-01 à EDI-07).

-- Les tables créées après 006_rls.sql reçoivent la même protection par cette fonction :
-- RLS activée, tous les droits pour les tâches de fond, droits demandés pour
-- l'application web, et règle d'isolation par espace.
CREATE FUNCTION app.protect_workspace_table(tbl regclass, web_privileges text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO app_worker', tbl);
  IF web_privileges <> '' THEN
    EXECUTE format('GRANT %s ON %s TO app_web', web_privileges, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %s FOR ALL TO app_web '
      'USING (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[])) '
      'WITH CHECK (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[]))',
      replace(tbl::text, '.', '_') || '_workspace_isolation', tbl);
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.protect_workspace_table(regclass, text) FROM PUBLIC;

-- EDI-01, EDI-02, EDI-07 : ligne éditoriale versionnée. Chaque enregistrement crée une
-- version ; une seule est en vigueur par espace. L'historique (qui, quand, quoi) se lit
-- en comparant les versions.
CREATE TABLE editorial_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  version        int NOT NULL CHECK (version >= 1),
  positioning    text,
  offers         text,
  audiences      text,
  allowed_proofs text,
  tone           text,
  banned_phrases text[] NOT NULL DEFAULT '{}',
  -- Règles communes (EDI-02) : format EditorialRules de @posts-auto/core.
  rules          jsonb NOT NULL,
  is_current     boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, version),
  CHECK (jsonb_typeof(rules) = 'object')
);
CREATE UNIQUE INDEX editorial_lines_current_idx ON editorial_lines (workspace_id) WHERE is_current;

-- EDI-03 : état de l'offre. L'IA ne cite que ce qui est disponible ; une offre
-- « en préparation » n'est jamais présentée comme disponible. La disponibilité et le
-- prix sont deux informations distinctes (le schéma de la v1.1 les mélangeait).
CREATE TABLE offer_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  position     int NOT NULL DEFAULT 0,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description  text,
  status       text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'planned', 'retired')),
  pricing      text CHECK (pricing IN ('free', 'paid')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offer_items_workspace_idx ON offer_items (workspace_id, position);
CREATE TRIGGER offer_items_touch BEFORE UPDATE ON offer_items FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- EDI-05 : exemples de référence par compte, « à imiter » ou « à éviter ».
-- Contenu externe : traité comme une donnée, jamais comme une consigne (GEN-13).
CREATE TABLE reference_posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id   uuid NOT NULL,
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  label        text NOT NULL CHECK (label IN ('imiter', 'eviter')),
  note         text,
  created_by   uuid REFERENCES users ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX reference_posts_account_idx ON reference_posts (account_id);

-- EDI-06 : résumé des préférences apprises d'un compte, visible et modifiable.
CREATE TABLE learned_preferences (
  account_id   uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  summary      text NOT NULL DEFAULT '',
  -- Dernière correction ou décision prise en compte dans le résumé.
  learned_until timestamptz,
  edited_by    uuid REFERENCES users ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE TRIGGER learned_preferences_touch BEFORE UPDATE ON learned_preferences FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Qui a modifié la fiche du compte en dernier (l'historique détaillé va au journal d'audit).
ALTER TABLE account_profiles ADD COLUMN updated_by uuid REFERENCES users ON DELETE SET NULL;

SELECT app.protect_workspace_table('editorial_lines', 'SELECT, INSERT, UPDATE');
SELECT app.protect_workspace_table('offer_items', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('reference_posts', 'SELECT, INSERT, UPDATE, DELETE');
SELECT app.protect_workspace_table('learned_preferences', 'SELECT, INSERT, UPDATE');

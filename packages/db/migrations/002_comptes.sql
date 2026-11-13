-- Comptes et droits (cahier des charges, sections 3 et 7).

CREATE TABLE organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) > 0),
  kind               text NOT NULL CHECK (kind IN ('entreprise', 'agence')),
  stripe_customer_id text UNIQUE,
  trial_ends_at      timestamptz,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'suspended', 'closed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  full_name     text,
  locale        text NOT NULL DEFAULT 'fr',
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Rôle au niveau de l'organisation : seul le propriétaire a des droits sur tous ses espaces.
CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members (user_id);

CREATE TABLE workspaces (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                        uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name                          text NOT NULL CHECK (length(btrim(name)) > 0),
  website                       text,
  sector                        text,
  -- Calendrier de l'espace (RÈG-01, RÈG-02) : même format que WorkspaceCalendar de @posts-auto/core.
  timezone                      text NOT NULL DEFAULT 'Europe/Paris',
  allowed_hours                 jsonb NOT NULL DEFAULT '{
    "1": [{"start": "08:00", "end": "18:00"}],
    "2": [{"start": "08:00", "end": "18:00"}],
    "3": [{"start": "08:00", "end": "18:00"}],
    "4": [{"start": "08:00", "end": "18:00"}],
    "5": [{"start": "08:00", "end": "18:00"}]
  }',
  holidays_calendar             text NOT NULL DEFAULT 'FR' CHECK (holidays_calendar IN ('FR', 'FR-alsace-moselle', 'none')),
  slot_step_minutes             int NOT NULL DEFAULT 30 CHECK (slot_step_minutes BETWEEN 5 AND 240),
  -- Règles d'occupation des créneaux (PUB-06, RÈG-08), réglables par espace.
  max_posts_per_account_per_day int NOT NULL DEFAULT 2 CHECK (max_posts_per_account_per_day >= 1),
  min_gap_minutes               int NOT NULL DEFAULT 30 CHECK (min_gap_minutes >= 0),
  max_posts_per_slot            int NOT NULL DEFAULT 2 CHECK (max_posts_per_slot >= 1),
  generation_cron               text NOT NULL DEFAULT '30 7 * * 1',
  branding                      jsonb,
  status                        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE INDEX workspaces_org_idx ON workspaces (org_id);

-- « Titulaire » n'est pas un rôle : c'est social_accounts.holder_user_id (section 3.2).
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('admin', 'editor', 'contributor', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- Clés de l'API d'échange (PUB-10). Seule l'empreinte est stockée.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users ON DELETE SET NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_workspace_idx ON api_keys (workspace_id);

CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER workspaces_touch BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

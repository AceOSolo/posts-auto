-- Comptes LinkedIn, jetons, consentements, délégations, fiches (sections 5.3, 5.4 et 7).
--
-- Les tables enfants portent workspace_id et une clé étrangère composite
-- (account_id, workspace_id) : une ligne ne peut pas être rattachée au compte
-- d'un autre espace, même si la RLS la laisse écrire dans son propre espace.

CREATE TABLE social_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  network        text NOT NULL DEFAULT 'linkedin' CHECK (network IN ('linkedin')),
  kind           text NOT NULL CHECK (kind IN ('profile', 'page')),
  external_urn   text NOT NULL,
  display_name   text,
  avatar_url     text,
  profile_url    text,
  holder_user_id uuid REFERENCES users ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'connected'
                 CHECK (status IN ('connected', 'expiring', 'expired', 'revoked', 'paused')),
  billable       boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE INDEX social_accounts_workspace_idx ON social_accounts (workspace_id);
-- LNK-06 : un compte LinkedIn dans un seul espace actif ; un compte révoqué peut être reconnecté ailleurs.
CREATE UNIQUE INDEX social_accounts_one_active_idx ON social_accounts (network, external_urn) WHERE status <> 'revoked';

-- SEC-02 : jetons chiffrés par l'application (AES-256-GCM, clé hors base). Aucun accès pour app_web.
CREATE TABLE social_tokens (
  account_id         uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL,
  oauth_client_id    text NOT NULL, -- application LinkedIn qui a émis le jeton (section 8.2)
  access_token_enc   bytea NOT NULL,
  refresh_token_enc  bytea,
  scopes             text[] NOT NULL,
  expires_at         timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  last_checked_at    timestamptz,
  connected_by       uuid REFERENCES users ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);

-- LNK-09 : consentements du titulaire, horodatés et retirables.
CREATE TABLE account_consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id   uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('publish', 'store_profile', 'ai_learning')),
  text_version text NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  ip           inet,
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX account_consents_active_idx ON account_consents (account_id, user_id, kind) WHERE revoked_at IS NULL;

-- ROL-01 : validateurs délégués d'un compte.
CREATE TABLE account_delegates (
  account_id   uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX account_delegates_user_idx ON account_delegates (user_id);

-- EDI-04 : fiche du compte (réduite à l'incrément 1a ; complétée au 1b).
CREATE TABLE account_profiles (
  account_id        uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL,
  voice             text CHECK (voice IN ('je', 'nous')),
  tenor             text,
  sensitivity       text NOT NULL DEFAULT 'standard' CHECK (sensitivity IN ('standard', 'prudent', 'strict')),
  avoid             text,
  posts_per_week    int NOT NULL DEFAULT 1 CHECK (posts_per_week >= 0),
  optional_per_week int NOT NULL DEFAULT 0 CHECK (optional_per_week >= 0),
  -- Heure locale + jour ISO, ex. [{"weekday": 2, "time": "12:00"}] (RÈG-02, type UsualSlot de @posts-auto/core).
  usual_slots       jsonb NOT NULL DEFAULT '[]',
  ai_image_ratio    numeric(3, 2) NOT NULL DEFAULT 0.5 CHECK (ai_image_ratio BETWEEN 0 AND 1),
  avatar_consent_at timestamptz,
  avatar_ref        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);

CREATE TRIGGER social_accounts_touch BEFORE UPDATE ON social_accounts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER social_tokens_touch BEFORE UPDATE ON social_tokens FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER account_profiles_touch BEFORE UPDATE ON account_profiles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

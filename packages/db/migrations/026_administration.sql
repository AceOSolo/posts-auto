-- Lot 2 : back-office de l'éditeur (ADM-01 à ADM-06, décision 0008).

-- Personnes de l'éditeur (SimplX) qui ont accès au back-office. Ajoutées à la main
-- (npm run admin:add -w @posts-auto/db), jamais depuis l'application.
CREATE TABLE platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ADM-04 : paramètres globaux (valeurs par défaut des nouveaux espaces et comptes).
CREATE TABLE platform_settings (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users ON DELETE SET NULL
);

-- ADM-02 : accord du client pour une intervention du support, limité dans le temps.
CREATE TABLE support_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  granted_by   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  reason       text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX support_grants_workspace_idx ON support_grants (workspace_id, expires_at);

-- Session ouverte par le support « en tant que » la personne qui a donné l'accord.
ALTER TABLE sessions
  ADD COLUMN support_admin_id uuid REFERENCES users ON DELETE CASCADE,
  ADD COLUMN support_grant_id uuid REFERENCES support_grants ON DELETE CASCADE;

-- ADM-05 : galerie de départ. Les modèles intégrés (code) peuvent être retirés ; des
-- modèles ajoutés par l'éditeur s'y ajoutent. Couleurs « brand.primary », « brand.secondary »,
-- « brand.light », « brand.dark » et police « brand.font » : remplacées par la charte de l'espace.
CREATE TABLE gallery_entries (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{1,40}$'),
  name       text,
  definition jsonb,
  with_photo boolean NOT NULL DEFAULT false,
  active     boolean NOT NULL DEFAULT true,
  position   int NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Un modèle ajouté a un nom et une définition ; une ligne sans définition retire ou
  -- réactive un modèle intégré.
  CHECK ((definition IS NULL) = (name IS NULL))
);

-- ADM-06 : annonces dans l'application.
CREATE TABLE announcements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message    text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 500),
  level      text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'maintenance')),
  starts_at  timestamptz NOT NULL DEFAULT now(),
  ends_at    timestamptz NOT NULL,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

-- Tout passe par les services, sous l'identité système, après vérification des droits.
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallery_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_admins, platform_settings, support_grants, gallery_entries, announcements TO app_worker;
-- La galerie et les paramètres sont lus à la copie des modèles de départ et à la création
-- d'un espace, parfois sous l'identité de la personne : lecture seule, rien de privé.
GRANT SELECT ON gallery_entries, platform_settings TO app_web;
CREATE POLICY gallery_entries_read ON gallery_entries FOR SELECT TO app_web USING (true);
CREATE POLICY platform_settings_read ON platform_settings FOR SELECT TO app_web USING (true);

-- Notifications, liens de validation, journal d'audit, authentification.

CREATE TABLE notifications (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces ON DELETE CASCADE,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  channel      text NOT NULL CHECK (channel IN ('email', 'in_app', 'push')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  read_at      timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at);

-- NOT-01 : réglage par type et par canal.
CREATE TABLE notification_prefs (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind    text NOT NULL,
  email   boolean NOT NULL DEFAULT true,
  in_app  boolean NOT NULL DEFAULT true,
  push    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, kind)
);

-- VAL-06, SEC-05 : liens de validation sans compte. Seule l'empreinte du jeton est stockée.
-- Accès réservé au système : la page de confirmation vérifie le jeton côté serveur.
CREATE TABLE approval_links (
  token_hash   text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  post_id      uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  action       text NOT NULL CHECK (action IN ('validate', 'open')),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE CASCADE
);

-- SEC-08 : journal d'audit, en ajout seul, conservé 1 an. Pas de clé étrangère vers users :
-- l'entrée survit à la suppression d'un utilisateur (identifiant seul, pseudonyme).
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  workspace_id  uuid,
  actor_user_id uuid,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('system', 'user', 'api_key', 'support')),
  action        text NOT NULL,
  entity        text NOT NULL,
  entity_id     text,
  details       jsonb,
  ip            inet,
  at            timestamptz NOT NULL DEFAULT now(),
  -- L'organisation d'une entrée d'espace est forcément celle de l'espace.
  FOREIGN KEY (workspace_id, org_id) REFERENCES workspaces (id, org_id) ON DELETE SET NULL (workspace_id)
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, at);
CREATE INDEX audit_log_workspace_idx ON audit_log (workspace_id, at);

-- SEC-03, ONB-01 : liens de connexion à usage unique (15 min) et sessions révocables (30 jours glissants).
-- Tables absentes du schéma de la v1.1, nécessaires à l'authentification. Accès réservé au système.
CREATE TABLE login_tokens (
  token_hash   text PRIMARY KEY,
  email        citext NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_tokens_email_idx ON login_tokens (email, created_at);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text,
  ip           inet
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

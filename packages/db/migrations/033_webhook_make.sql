-- LNK-08 : publication par un scénario du client (Make, Zapier, n8n…) : au créneau, le post
-- validé est envoyé à son adresse de webhook (HTTPS), signé, au lieu de partir par l'API.
ALTER TABLE social_accounts DROP CONSTRAINT social_accounts_publish_mode_check;
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_publish_mode_check CHECK (publish_mode IN ('auto', 'manual', 'webhook'));

CREATE TABLE account_webhooks (
  account_id   uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  url          text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 500),
  -- Secret de signature, chiffré (SEC-02) ; montré une seule fois à sa création.
  secret_enc   bytea NOT NULL,
  created_by   uuid REFERENCES users ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);
ALTER TABLE account_webhooks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_webhooks TO app_worker;

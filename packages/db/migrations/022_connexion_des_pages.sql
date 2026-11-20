-- LNK-02 : connexion des pages d'entreprise. Après l'autorisation sur LinkedIn, la personne
-- choisit les pages à ajouter parmi celles qu'elle administre ; le jeton attend ce choix
-- ici, chiffré, au plus 15 minutes. Réservée au système, comme social_tokens.
CREATE TABLE page_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  oauth_client_id    text NOT NULL,
  access_token_enc   bytea NOT NULL,
  refresh_token_enc  bytea,
  scopes             text[] NOT NULL,
  token_expires_at   timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  pages              jsonb NOT NULL CHECK (jsonb_typeof(pages) = 'array'),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_connections_expiry_idx ON page_connections (expires_at);
ALTER TABLE page_connections ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON page_connections TO app_worker;

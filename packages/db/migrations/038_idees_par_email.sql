-- IDE-07 : création d'idée ou de demande par e-mail, avec une adresse dédiée par espace.
-- L'adresse est dérivée d'un secret de l'application et du numéro de rotation : seule son
-- empreinte est stockée. Changer d'adresse invalide immédiatement la précédente.
CREATE TABLE workspace_inbound_email (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,
  rotation     int NOT NULL DEFAULT 1 CHECK (rotation >= 1),
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid REFERENCES users ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER workspace_inbound_email_touch BEFORE UPDATE ON workspace_inbound_email FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Trace minimale des e-mails reçus (doublons et limite quotidienne), gardée 30 jours :
-- ni expéditeur, ni objet, ni contenu ; l'identifiant du message n'y est qu'en empreinte.
CREATE TABLE inbound_emails (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  message_hash text NOT NULL,
  outcome      text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'idea', 'request', 'ignored')),
  reason       text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, message_hash)
);
CREATE INDEX inbound_emails_recent_idx ON inbound_emails (workspace_id, received_at);

-- Lus et écrits par le code système seulement, après vérification des droits.
ALTER TABLE workspace_inbound_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_emails ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_inbound_email TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON inbound_emails TO app_worker;

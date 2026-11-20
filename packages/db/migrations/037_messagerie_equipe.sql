-- Messagerie d'équipe : l'espace relie un canal Slack ou Microsoft Teams (webhook entrant)
-- pour y annoncer les posts à valider, les échecs de publication et les posts publiés (à
-- relayer par l'équipe). L'adresse du webhook est un secret : chiffrée (SEC-02), jamais
-- réaffichée ; seul son début sert à la reconnaître.
CREATE TABLE workspace_chat_hooks (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('slack', 'teams')),
  url_enc       bytea NOT NULL,
  url_hint      text NOT NULL,
  events        text[] NOT NULL DEFAULT '{a_valider,erreurs,publies}',
  created_by    uuid REFERENCES users ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz,
  last_error    text,
  CHECK (events <@ ARRAY['a_valider', 'erreurs', 'publies']::text[])
);

-- File des messages à envoyer, traitée par le worker (nouvel essai sur erreur passagère).
CREATE TABLE chat_messages (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  event        text NOT NULL CHECK (event IN ('a_valider', 'erreurs', 'publies', 'essai')),
  payload      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  status       text CHECK (status IN ('sent', 'skipped', 'failed')),
  attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at      timestamptz,
  last_error   text
);
CREATE INDEX chat_messages_to_send_idx ON chat_messages (created_at) WHERE status IS NULL;

-- Lus et écrits par le code système seulement, après vérification des droits.
ALTER TABLE workspace_chat_hooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_chat_hooks TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO app_worker;

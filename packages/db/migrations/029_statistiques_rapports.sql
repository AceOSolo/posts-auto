-- Lot 2 : statistiques LinkedIn (SUI-03), enseignements du mois (SUI-04), rapport mensuel (SUI-05).

-- SUI-03 : statistiques d'un post publié, relevées à J+1, J+7 et J+30. available = false :
-- LinkedIn ne les donne pas pour ce compte (permission absente) ; rien n'est inventé.
CREATE TABLE post_stats (
  post_id      uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  day_offset   smallint NOT NULL CHECK (day_offset IN (1, 7, 30)),
  captured_at  timestamptz NOT NULL DEFAULT now(),
  available    boolean NOT NULL DEFAULT true,
  impressions  int CHECK (impressions >= 0),
  reactions    int CHECK (reactions >= 0),
  comments     int CHECK (comments >= 0),
  shares       int CHECK (shares >= 0),
  PRIMARY KEY (post_id, day_offset),
  FOREIGN KEY (post_id, workspace_id) REFERENCES posts (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX post_stats_workspace_idx ON post_stats (workspace_id, captured_at);

-- SUI-03 : abonnés des pages, un relevé par jour.
CREATE TABLE account_followers (
  account_id   uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  captured_on  date NOT NULL,
  followers    int NOT NULL CHECK (followers >= 0),
  PRIMARY KEY (account_id, captured_on),
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);

-- SUI-04 : 3 constats par mois, tirés des statistiques et des décisions, réinjectés dans la
-- rédaction. month : premier jour du mois analysé.
CREATE TABLE monthly_insights (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  month        date NOT NULL,
  insights     jsonb NOT NULL,
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month)
);

-- SUI-05 : envoi automatique du rapport mensuel (facultatif) et rapports déjà envoyés.
ALTER TABLE workspaces ADD COLUMN monthly_report_email boolean NOT NULL DEFAULT false;
CREATE TABLE monthly_reports_sent (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  month        date NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month)
);

SELECT app.protect_workspace_table('post_stats', 'SELECT');
SELECT app.protect_workspace_table('account_followers', 'SELECT');
SELECT app.protect_workspace_table('monthly_insights', 'SELECT');
SELECT app.protect_workspace_table('monthly_reports_sent', 'SELECT');

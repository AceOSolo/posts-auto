-- VIS-06 : personnage de marque autorisé. Le titulaire d'un compte déclare un avatar généré
-- de lui-même, avec son consentement écrit enregistré ; l'avatar ne sert que sur les posts de
-- ce compte (il n'est pas dans la médiathèque de l'espace) et peut être retiré à tout moment.
CREATE TABLE account_avatars (
  account_id      uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES media_assets ON DELETE CASCADE,
  consent_version text NOT NULL,
  consent_text    text NOT NULL,
  consented_by    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  consented_at    timestamptz NOT NULL DEFAULT now(),
  consent_ip      inet,
  revoked_at      timestamptz,
  FOREIGN KEY (account_id, workspace_id) REFERENCES social_accounts (id, workspace_id) ON DELETE CASCADE
);
SELECT app.protect_workspace_table('account_avatars', 'SELECT');

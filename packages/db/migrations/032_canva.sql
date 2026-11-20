-- VIS-07 : connecteur Canva. Connexion d'un espace au Canva du client (jetons chiffrés,
-- réservés au système) ; un modèle peut être un modèle de marque Canva, dont les champs
-- sont reliés aux zones du visuel. Sa « définition » locale sert au choix du modèle
-- (photo, liste de points) et au rendu de secours quand Canva ne répond pas.
CREATE TABLE canva_connections (
  workspace_id      uuid PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,
  access_token_enc  bytea NOT NULL,
  refresh_token_enc bytea NOT NULL,
  expires_at        timestamptz NOT NULL,
  connected_by      uuid REFERENCES users ON DELETE SET NULL,
  connected_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE canva_connections ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON canva_connections TO app_worker;

ALTER TABLE templates
  ADD COLUMN canva_brand_template_id text,
  ADD COLUMN canva_fields jsonb;

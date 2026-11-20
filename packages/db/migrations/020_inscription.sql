-- Lot 2, incrément 2a : inscription en libre-service et démarrage (ONB-01 à ONB-03, ONB-06).

-- ONB-01, ONB-02 : une demande d'inscription attend la confirmation par e-mail.
-- L'organisation, son premier espace et l'essai ne sont créés qu'au clic sur le lien.
-- Réservée au système, comme login_tokens : aucun droit pour app_web.
CREATE TABLE signup_requests (
  token_hash   text PRIMARY KEY,
  email        citext NOT NULL,
  full_name    text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  org_name     text NOT NULL CHECK (length(btrim(org_name)) BETWEEN 1 AND 120),
  org_kind     text NOT NULL CHECK (org_kind IN ('entreprise', 'agence')),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signup_requests_email_idx ON signup_requests (email, created_at);
CREATE INDEX signup_requests_ip_idx ON signup_requests (requested_ip, created_at) WHERE requested_ip IS NOT NULL;
ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON signup_requests TO app_worker;

-- ONB-03, étape 1 : l'entreprise (nom, site, secteur, taille). Le site et le secteur
-- existent déjà sur l'espace ; la taille s'y ajoute.
ALTER TABLE workspaces
  ADD COLUMN company_size text CHECK (company_size IS NULL OR company_size IN ('1-9', '10-49', '50-249', '250+')),
  -- ONB-03, ONB-08 : l'assistant est terminé (ou fermé) ; l'avancement reste calculé.
  ADD COLUMN onboarding_done_at timestamptz;

-- Lot 2 : site vitrine (SIT-02) : demandes de démonstration, transmises à l'éditeur
-- (e-mail et, si configuré, son CRM). Réservé au système.
CREATE TABLE demo_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  company      text NOT NULL CHECK (length(company) BETWEEN 1 AND 160),
  email        citext NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone        text CHECK (phone IS NULL OR length(phone) <= 40),
  accounts     int CHECK (accounts IS NULL OR accounts BETWEEN 1 AND 10000),
  message      text CHECK (message IS NULL OR length(message) <= 2000),
  requested_ip inet,
  forwarded_at timestamptz,
  forward_error text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_requests_ip_idx ON demo_requests (requested_ip, created_at) WHERE requested_ip IS NOT NULL;
ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON demo_requests TO app_worker;

-- Back-office : interventions de l'éditeur (complément de la décision 0008).

-- Suspension décidée par l'éditeur. Elle est distincte de organizations.status, qui suit les
-- impayés : un paiement Stripe ne la lève pas, et elle ne déclenche jamais la purge à 90 jours.
-- L'historique est conservé ; le motif reste interne à l'éditeur.
CREATE TABLE org_suspensions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  reason       text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  suspended_by uuid REFERENCES users ON DELETE SET NULL,
  suspended_at timestamptz NOT NULL DEFAULT now(),
  lifted_by    uuid REFERENCES users ON DELETE SET NULL,
  lifted_at    timestamptz,
  CHECK (lifted_at IS NULL OR lifted_at >= suspended_at)
);
CREATE UNIQUE INDEX org_suspensions_active_idx ON org_suspensions (org_id) WHERE lifted_at IS NULL;
CREATE INDEX org_suspensions_org_idx ON org_suspensions (org_id, suspended_at DESC);

ALTER TABLE org_suspensions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_suspensions TO app_worker;
-- Le client sait que son organisation est suspendue, sans accès au motif ni à son auteur.
GRANT SELECT (org_id, lifted_at) ON org_suspensions TO app_web;
CREATE POLICY org_suspensions_read ON org_suspensions FOR SELECT TO app_web
  USING (org_id = ANY ((SELECT app.accessible_org_ids())::uuid[]));

-- SIT-02 : suivi commercial des demandes de démonstration.
ALTER TABLE demo_requests
  ADD COLUMN status     text NOT NULL DEFAULT 'nouvelle' CHECK (status IN ('nouvelle', 'contactee', 'demo_faite', 'gagnee', 'perdue')),
  ADD COLUMN note       text CHECK (note IS NULL OR length(note) <= 1000),
  ADD COLUMN handled_by uuid REFERENCES users ON DELETE SET NULL,
  ADD COLUMN handled_at timestamptz;
CREATE INDEX demo_requests_status_idx ON demo_requests (status, created_at DESC);

-- Lot 2 : abonnement et facturation (FAC-01 à FAC-07, section 5.13, décision 0007).

-- Formules : quotas par compte et par mois, mutualisés dans l'espace [C6]. Les prix sont
-- dans Stripe ; ici, seulement les identifiants des prix, à renseigner quand ils seront
-- fixés. Une formule sans prix n'est pas proposée à la souscription.
CREATE TABLE plans (
  key                  text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  name                 text NOT NULL,
  position             int NOT NULL DEFAULT 0,
  -- Posts rédigés par l'IA par compte et par mois (RÈG-19 : premières rédactions).
  posts_per_account    int NOT NULL CHECK (posts_per_account >= 0),
  -- Images générées par compte et par mois ; NULL : pas de plafond de formule (le budget
  -- d'images de l'espace s'applique, VIS-05).
  images_per_account   int CHECK (images_per_account IS NULL OR images_per_account >= 0),
  -- Espaces de l'organisation ; NULL : illimités (Agence).
  max_workspaces       int CHECK (max_workspaces IS NULL OR max_workspaces >= 1),
  features             text[] NOT NULL DEFAULT '{}',
  stripe_price_monthly text,
  stripe_price_yearly  text,
  active               boolean NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO plans (key, name, position, posts_per_account, images_per_account, max_workspaces, features) VALUES
  ('essentiel', 'Essentiel', 1, 16, NULL, 1, '{}'),
  ('pro', 'Pro', 2, 32, NULL, 1, '{canva,sources,statistiques}'),
  ('agence', 'Agence', 3, 32, NULL, NULL, '{canva,sources,statistiques,espaces_illimites,rapports}');

-- Pack de dépassement (FAC-04) : prix Stripe d'un pack, et ce qu'il ajoute à l'espace.
CREATE TABLE quota_pack_offers (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{1,30}$'),
  name         text NOT NULL,
  posts        int NOT NULL DEFAULT 0 CHECK (posts >= 0),
  images       int NOT NULL DEFAULT 0 CHECK (images >= 0),
  stripe_price text,
  active       boolean NOT NULL DEFAULT true
);
INSERT INTO quota_pack_offers (key, name, posts, images) VALUES ('pack-posts', 'Pack de 20 posts', 20, 0), ('pack-images', 'Pack de 20 images', 0, 20);

-- Abonnement de l'organisation, reflet de Stripe (mis à jour par les événements reçus).
CREATE TABLE subscriptions (
  org_id                 uuid PRIMARY KEY REFERENCES organizations ON DELETE CASCADE,
  plan_key               text NOT NULL REFERENCES plans,
  stripe_subscription_id text UNIQUE,
  status                 text NOT NULL CHECK (status IN ('incomplete', 'active', 'past_due', 'unpaid', 'canceled')),
  billing_interval       text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  quantity               int NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  current_period_start   timestamptz NOT NULL,
  current_period_end     timestamptz NOT NULL,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  -- FAC-04 : au plafond, rédaction suspendue ou packs supplémentaires (au choix du client).
  overage_policy         text NOT NULL DEFAULT 'suspend' CHECK (overage_policy IN ('suspend', 'packs')),
  -- FAC-06 : premier impayé, pour les relances et la suspension à J+14.
  past_due_since         timestamptz,
  reminders_sent         text[] NOT NULL DEFAULT '{}',
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);

-- Packs achetés : valables pour la période de l'abonnement en cours, dans un espace.
CREATE TABLE quota_packs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  offer_key     text NOT NULL REFERENCES quota_pack_offers,
  posts         int NOT NULL CHECK (posts >= 0),
  images        int NOT NULL CHECK (images >= 0),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  stripe_ref    text UNIQUE,
  purchased_by  uuid REFERENCES users ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_packs_workspace_idx ON quota_packs (workspace_id, period_end);

-- Alertes d'usage déjà envoyées (80 %, 100 %), une fois par espace et par période.
CREATE TABLE usage_alerts (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('posts_80', 'posts_100', 'images_80', 'images_100')),
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, period_start, kind)
);

-- Événements Stripe déjà traités (un événement peut arriver plusieurs fois).
CREATE TABLE billing_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Catalogue lisible par l'application ; le reste est écrit par le système (webhook, tâches)
-- et lu par l'application sous l'identité de la personne.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_pack_offers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON plans, quota_pack_offers TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON plans, quota_pack_offers TO app_worker;
CREATE POLICY plans_read ON plans FOR SELECT TO app_web USING (true);
CREATE POLICY quota_pack_offers_read ON quota_pack_offers FOR SELECT TO app_web USING (true);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON subscriptions TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions TO app_worker;
CREATE POLICY subscriptions_read ON subscriptions FOR SELECT TO app_web
  USING (org_id IN (SELECT w.org_id FROM workspaces w WHERE w.id = ANY ((SELECT app.accessible_workspace_ids())::uuid[])));

SELECT app.protect_workspace_table('quota_packs', 'SELECT');
SELECT app.protect_workspace_table('usage_alerts', 'SELECT');
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_events TO app_worker;

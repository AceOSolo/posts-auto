-- Envoi des notifications par e-mail (section 5.12) et rappels de validation (VAL-05).

-- Acheminement de chaque notification e-mail : envoyée, écartée (préférence de la
-- personne, NOT-01), ou en échec après plusieurs essais.
ALTER TABLE notifications
  ADD COLUMN delivery_status text CHECK (delivery_status IN ('sent', 'skipped', 'failed')),
  ADD COLUMN delivery_attempts int NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  ADD COLUMN last_error text;
CREATE INDEX notifications_to_send_idx ON notifications (created_at) WHERE channel = 'email' AND delivery_status IS NULL;

-- Rappels déjà envoyés pour un post, chacun lié au créneau qu'il annonçait
-- (ex. « 24h@2026-11-17T11:00:00.000Z ») : un post replanifié reçoit de nouveaux rappels.
ALTER TABLE posts ADD COLUMN reminders_sent text[] NOT NULL DEFAULT '{}';

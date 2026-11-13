-- Surveillance des connexions LinkedIn (LNK-04) : alertes à J-14, J-3 et à l'expiration,
-- envoyées une seule fois par échéance. Remis à zéro à chaque reconnexion.
ALTER TABLE social_tokens
  ADD COLUMN expiry_alerts_sent text[] NOT NULL DEFAULT '{}'
  CHECK (expiry_alerts_sent <@ ARRAY['j14', 'j3', 'j0']::text[]);

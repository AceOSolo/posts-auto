-- SEC-04 : double authentification (TOTP, RFC 6238), possible pour tous, obligatoire
-- pour les propriétaires et les administrateurs (après un délai de mise en place).

-- Secret chiffré (même chiffrement que les jetons LinkedIn, SEC-02), lié à la personne.
-- confirmed_at NULL : mise en place commencée, pas encore confirmée par un premier code.
CREATE TABLE user_totp (
  user_id          uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  secret_encrypted bytea NOT NULL,
  confirmed_at     timestamptz,
  -- Dernier pas de 30 secondes accepté : un code ne sert qu'une fois.
  last_step        bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Codes de secours (10, à usage unique), conservés par empreinte.
CREATE TABLE totp_recovery_codes (
  user_id   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- Session : second facteur vérifié, et essais manqués (session révoquée au 5e).
ALTER TABLE sessions
  ADD COLUMN mfa_verified_at timestamptz,
  ADD COLUMN mfa_failures    int NOT NULL DEFAULT 0;

-- Réservé au système : l'application web passe par les services (asSystem).
ALTER TABLE user_totp ENABLE ROW LEVEL SECURITY;
ALTER TABLE totp_recovery_codes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_totp, totp_recovery_codes TO app_worker;

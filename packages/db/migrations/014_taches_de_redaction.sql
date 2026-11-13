-- Tâches de rédaction (section 8.4, décision 0005).

-- GEN-01, REC-04 : « Lancer la rédaction » depuis l'application. La rédaction prend
-- plusieurs minutes : l'application note la demande, la tâche de fond l'exécute.
ALTER TABLE workspaces ADD COLUMN generation_requested_at timestamptz;

-- Rédaction hebdomadaire automatique (selon generation_cron) : désactivée tant que
-- l'administrateur ne l'a pas activée. Pendant la bascule (RÈG-21), l'outil actuel rédige
-- encore : deux rédactions en parallèle produiraient des doublons.
ALTER TABLE workspaces ADD COLUMN auto_generation boolean NOT NULL DEFAULT false;

-- GEN-07 : reprise en cours d'un post « à modifier » ou « refusé ». Un appel à l'IA dure
-- trop longtemps pour garder une transaction ouverte : un bail évite qu'une autre passe
-- reprenne le même post, et une passe interrompue est reprise quand il expire.
ALTER TABLE posts ADD COLUMN rework_lease_until timestamptz,
  ADD COLUMN rework_attempts int NOT NULL DEFAULT 0 CHECK (rework_attempts >= 0);
CREATE INDEX posts_rework_idx ON posts (updated_at) WHERE status IN ('modif', 'refuse');

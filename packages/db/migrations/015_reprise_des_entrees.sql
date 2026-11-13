-- Reprise des idées et des demandes de l'outil actuel (incrément 1b), par l'API d'échange.

-- Référence de l'outil d'origine : renvoyer la même référence ne crée jamais de doublon.
ALTER TABLE ideas ADD COLUMN external_ref text;
CREATE UNIQUE INDEX ideas_external_ref_idx ON ideas (workspace_id, external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE post_requests ADD COLUMN external_ref text;
CREATE UNIQUE INDEX post_requests_external_ref_idx ON post_requests (workspace_id, external_ref) WHERE external_ref IS NOT NULL;

-- Une demande reprise de l'ancien outil peut venir d'une personne sans compte ici : son nom
-- est gardé tel quel. Toute demande a un demandeur, compte ou nom.
ALTER TABLE post_requests ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN requester_label text CHECK (length(requester_label) <= 200),
  ADD CONSTRAINT post_requests_requester_check CHECK (created_by IS NOT NULL OR requester_label IS NOT NULL);

-- PUB-09 : mode « publication manuelle » par compte. Au créneau, le post validé est envoyé
-- par e-mail au titulaire (texte à copier et images jointes) au lieu de partir par l'API.
ALTER TABLE social_accounts
  ADD COLUMN publish_mode text NOT NULL DEFAULT 'auto' CHECK (publish_mode IN ('auto', 'manual'));

-- Post envoyé pour publication manuelle (statut « publié » : il a quitté la file) ; le lien
-- LinkedIn est ajouté ensuite par le titulaire s'il le souhaite.
ALTER TABLE posts
  ADD COLUMN published_manually boolean NOT NULL DEFAULT false;

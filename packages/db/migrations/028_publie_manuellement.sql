-- PUB-09 : un post publié à la main n'a pas d'identifiant LinkedIn (URN) ; il en a un dès
-- qu'il part par l'API.
ALTER TABLE posts DROP CONSTRAINT posts_check;
ALTER TABLE posts ADD CONSTRAINT posts_published_check
  CHECK (status <> 'publie' OR (published_at IS NOT NULL AND (external_post_urn IS NOT NULL OR published_manually)));

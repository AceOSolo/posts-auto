-- PUB-07 : premier commentaire (lien, complément) publié juste après le post, quand l'API
-- le permet pour ce type de compte. Son échec n'annule pas la publication du post.
ALTER TABLE posts
  ADD COLUMN first_comment        text CHECK (first_comment IS NULL OR length(first_comment) BETWEEN 1 AND 1250),
  ADD COLUMN first_comment_status text CHECK (first_comment_status IS NULL OR first_comment_status IN ('posted', 'failed', 'skipped')),
  ADD COLUMN first_comment_error  text;

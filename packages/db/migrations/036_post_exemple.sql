-- Démarrage : post d'exemple rédigé par l'IA à partir du site de l'entreprise, pour montrer le
-- résultat avant la connexion d'un compte LinkedIn. Jamais publié ; le dernier remplace le
-- précédent. { body, summary, sourceUrl, suspicious, createdAt }.
ALTER TABLE workspaces ADD COLUMN sample_post jsonb;

-- Suppression complète d'un client (RGPD, section 10.2 : suppression définitive après
-- résiliation).
--
-- Supprimer un espace efface en cascade ses comptes, posts, médias… Mais trois liens
-- étaient contrôlés immédiatement, au milieu de la cascade, avant que les lignes qui les
-- référencent soient effacées : la suppression échouait dès qu'un post avait une image.
-- Contrôlés en fin de transaction, ils gardent leur protection (on ne peut toujours pas
-- supprimer seul un compte, une image ou un post encore référencé) sans bloquer la cascade.

ALTER TABLE post_media ALTER CONSTRAINT post_media_asset_id_workspace_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE posts ALTER CONSTRAINT posts_account_id_workspace_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE posts ALTER CONSTRAINT posts_replaces_post_id_workspace_id_fkey DEFERRABLE INITIALLY DEFERRED;

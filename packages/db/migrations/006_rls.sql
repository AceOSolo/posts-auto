-- Cloisonnement des clients par la sécurité au niveau des lignes (SEC-01).
--
-- Principe : la RLS garantit l'ISOLATION (un utilisateur ne voit et n'écrit que dans les
-- espaces auxquels il a accès). Les droits fins (éditeur, contributeur, titulaire…) sont
-- vérifiés par l'application. Les deux couches sont nécessaires : un bug applicatif ne
-- doit jamais suffire à exposer les données d'un autre client.
--
-- Accès à un espace : membre de l'espace, ou propriétaire de l'organisation qui le contient.
-- Un client d'agence, membre d'un seul espace, ne voit donc jamais les autres clients (ROL-02).

-- Les fonctions suivantes lisent les tables d'appartenance en contournant la RLS
-- (SECURITY DEFINER), ce qui évite que les règles s'appellent elles-mêmes.
-- Elles ne renvoient que des identifiants liés à l'utilisateur courant.

CREATE FUNCTION app.accessible_workspace_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(w.id), '{}')
  FROM workspaces w
  WHERE EXISTS (SELECT 1 FROM workspace_members m
                WHERE m.workspace_id = w.id AND m.user_id = app.current_user_id())
     OR EXISTS (SELECT 1 FROM org_members o
                WHERE o.org_id = w.org_id AND o.user_id = app.current_user_id() AND o.role = 'owner')
$$;

-- Organisations dont l'utilisateur est propriétaire.
CREATE FUNCTION app.owned_org_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(o.org_id), '{}')
  FROM org_members o
  WHERE o.user_id = app.current_user_id() AND o.role = 'owner'
$$;

-- Organisations visibles : celles dont l'utilisateur est membre, et celles qui contiennent
-- un espace accessible (un client d'agence voit le nom de son agence, pas ses autres clients).
CREATE FUNCTION app.accessible_org_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT x.org_id), '{}')
  FROM (
    SELECT o.org_id FROM org_members o WHERE o.user_id = app.current_user_id()
    UNION
    SELECT w.org_id FROM workspaces w WHERE w.id = ANY (app.accessible_workspace_ids())
  ) x
$$;

-- Utilisateurs visibles : soi-même, les membres des espaces accessibles, les membres
-- des organisations dont on est membre.
CREATE FUNCTION app.visible_user_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT x.user_id), '{}')
  FROM (
    SELECT app.current_user_id() AS user_id
    UNION
    SELECT m.user_id FROM workspace_members m WHERE m.workspace_id = ANY (app.accessible_workspace_ids())
    UNION
    SELECT o2.user_id FROM org_members o1 JOIN org_members o2 ON o2.org_id = o1.org_id
    WHERE o1.user_id = app.current_user_id()
  ) x
  WHERE x.user_id IS NOT NULL
$$;

REVOKE ALL ON FUNCTION app.accessible_workspace_ids(), app.owned_org_ids(),
  app.accessible_org_ids(), app.visible_user_ids(), app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accessible_workspace_ids(), app.owned_org_ids(),
  app.accessible_org_ids(), app.visible_user_ids(), app.current_user_id() TO app_web, app_worker;

-- RLS activée sur toutes les tables : sans règle explicite, app_web ne voit rien.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Tâches de fond : tous les droits, sans RLS (rôle BYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_worker, app_web;

-- Organisations : lecture des organisations visibles, modification par le propriétaire.
-- La création (inscription) passe par le système.
GRANT SELECT, UPDATE ON organizations TO app_web;
CREATE POLICY organizations_select ON organizations FOR SELECT TO app_web
  USING (id = ANY ((SELECT app.accessible_org_ids())::uuid[]));
CREATE POLICY organizations_update ON organizations FOR UPDATE TO app_web
  USING (id = ANY ((SELECT app.owned_org_ids())::uuid[]))
  WITH CHECK (id = ANY ((SELECT app.owned_org_ids())::uuid[]));

-- Utilisateurs : lecture des utilisateurs visibles, modification de soi seulement.
-- La création (invitation) passe par le système.
GRANT SELECT, UPDATE ON users TO app_web;
CREATE POLICY users_select ON users FOR SELECT TO app_web
  USING (id = ANY ((SELECT app.visible_user_ids())::uuid[]));
CREATE POLICY users_update ON users FOR UPDATE TO app_web
  USING (id = app.current_user_id())
  WITH CHECK (id = app.current_user_id());

-- Membres d'organisation : visibles dans les organisations visibles, gérés par le propriétaire.
GRANT SELECT, INSERT, UPDATE, DELETE ON org_members TO app_web;
CREATE POLICY org_members_select ON org_members FOR SELECT TO app_web
  USING (org_id = ANY ((SELECT app.accessible_org_ids())::uuid[]));
CREATE POLICY org_members_write ON org_members FOR ALL TO app_web
  USING (org_id = ANY ((SELECT app.owned_org_ids())::uuid[]))
  WITH CHECK (org_id = ANY ((SELECT app.owned_org_ids())::uuid[]));

-- Espaces : lecture et modification des espaces accessibles ; création et suppression
-- par le propriétaire de l'organisation.
GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces TO app_web;
CREATE POLICY workspaces_select ON workspaces FOR SELECT TO app_web
  USING (id = ANY ((SELECT app.accessible_workspace_ids())::uuid[]));
CREATE POLICY workspaces_update ON workspaces FOR UPDATE TO app_web
  USING (id = ANY ((SELECT app.accessible_workspace_ids())::uuid[]))
  WITH CHECK (id = ANY ((SELECT app.accessible_workspace_ids())::uuid[]));
CREATE POLICY workspaces_insert ON workspaces FOR INSERT TO app_web
  WITH CHECK (org_id = ANY ((SELECT app.owned_org_ids())::uuid[]));
CREATE POLICY workspaces_delete ON workspaces FOR DELETE TO app_web
  USING (org_id = ANY ((SELECT app.owned_org_ids())::uuid[]));

-- Tables rattachées à un espace : même règle partout.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_members', 'api_keys', 'social_accounts', 'account_consents', 'account_delegates',
    'account_profiles', 'media_assets', 'posts', 'post_versions', 'post_media'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_web', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO app_web '
      'USING (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[])) '
      'WITH CHECK (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[]))',
      t || '_workspace_isolation', t);
  END LOOP;
END
$$;

-- Historique des statuts : lecture et ajout seulement (aucune réécriture de l'historique).
GRANT SELECT, INSERT ON post_status_history TO app_web;
CREATE POLICY post_status_history_select ON post_status_history FOR SELECT TO app_web
  USING (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[]));
CREATE POLICY post_status_history_insert ON post_status_history FOR INSERT TO app_web
  WITH CHECK (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[]));

-- Tentatives de publication : écrites par le système, lisibles par l'espace.
GRANT SELECT ON publish_attempts TO app_web;
CREATE POLICY publish_attempts_select ON publish_attempts FOR SELECT TO app_web
  USING (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[]));

-- Notifications et préférences : chacun ne voit que les siennes.
GRANT SELECT, UPDATE ON notifications TO app_web;
CREATE POLICY notifications_own ON notifications FOR ALL TO app_web
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_prefs TO app_web;
CREATE POLICY notification_prefs_own ON notification_prefs FOR ALL TO app_web
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- Journal d'audit : ajout seul. Les entrées d'un espace sont visibles dans cet espace ;
-- les entrées de niveau organisation (facturation…) par le propriétaire seulement :
-- un client d'agence ne voit pas le journal de l'agence.
GRANT SELECT, INSERT ON audit_log TO app_web;
CREATE POLICY audit_log_select ON audit_log FOR SELECT TO app_web
  USING (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[])
         OR (workspace_id IS NULL AND org_id = ANY ((SELECT app.owned_org_ids())::uuid[])));
CREATE POLICY audit_log_insert ON audit_log FOR INSERT TO app_web
  WITH CHECK (workspace_id = ANY ((SELECT app.accessible_workspace_ids())::uuid[])
              OR (workspace_id IS NULL AND org_id = ANY ((SELECT app.owned_org_ids())::uuid[])));

-- social_tokens, approval_links, login_tokens, sessions : aucun droit pour app_web.
-- Ces tables ne sont manipulées que par du code serveur de confiance, en contexte système.

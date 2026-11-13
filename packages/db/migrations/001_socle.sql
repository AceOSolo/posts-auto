-- Socle : extensions, rôles applicatifs, schéma utilitaire.
--
-- Deux rôles sans connexion portent les droits ; les comptes de connexion réels
-- (un par processus) en sont membres et basculent dessus avec SET LOCAL ROLE :
--   app_web    : application web et API ; soumis à la sécurité au niveau des lignes (RLS).
--   app_worker : tâches de fond (publication, replanification, jetons) ; traverse la RLS.
-- Les rôles sont globaux au serveur : on ne les crée que s'ils n'existent pas.

CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web') THEN
    CREATE ROLE app_web NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOLOGIN BYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO app_web, app_worker;
GRANT USAGE ON SCHEMA public TO app_web, app_worker;

-- Mise à jour automatique de updated_at.
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Utilisateur courant, posé par l'application au début de chaque transaction :
--   SELECT set_config('app.user_id', '<uuid>', true);
-- Sans contexte, la fonction renvoie NULL et les règles RLS ne laissent rien passer.
CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

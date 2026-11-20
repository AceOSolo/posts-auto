-- ONB-03, ONB-08 : les espaces créés avant l'inscription en libre-service ont été mis en
-- place à la main (Secutop) ; l'assistant de démarrage ne s'y affiche pas.
UPDATE workspaces SET onboarding_done_at = created_at WHERE onboarding_done_at IS NULL;

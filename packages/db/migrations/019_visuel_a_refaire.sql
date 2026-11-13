-- VIS-13 : « refaire le visuel » propose trois choix pour la photo — la garder, en changer,
-- ou faire un visuel sans photo. Un booléen « nouvelle photo » ne pouvait pas dire le dernier.
ALTER TABLE visual_tasks ADD COLUMN photo_mode text NOT NULL DEFAULT 'keep' CHECK (photo_mode IN ('keep', 'new', 'none'));
UPDATE visual_tasks SET photo_mode = 'new' WHERE new_photo;
ALTER TABLE visual_tasks DROP COLUMN new_photo;

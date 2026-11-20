-- VIS-10 : carrousel LinkedIn natif, un document PDF dont chaque page est rendue à partir
-- d'un modèle de l'espace. Il remplace les images du post et part par l'API Documents.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_mime_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_mime_check
  CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'application/pdf'));

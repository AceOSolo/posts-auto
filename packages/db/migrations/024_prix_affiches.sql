-- Prix affichés sur la page d'abonnement, en centimes hors taxes (FAC-03). Le montant
-- réellement facturé reste celui du prix Stripe : ces colonnes ne servent qu'à l'affichage
-- et sont mises à jour en même temps que les prix Stripe. NULL : prix pas encore fixé.
ALTER TABLE plans
  ADD COLUMN price_monthly_cents int CHECK (price_monthly_cents IS NULL OR price_monthly_cents >= 0),
  ADD COLUMN price_yearly_cents  int CHECK (price_yearly_cents IS NULL OR price_yearly_cents >= 0);
ALTER TABLE quota_pack_offers
  ADD COLUMN price_cents int CHECK (price_cents IS NULL OR price_cents >= 0);

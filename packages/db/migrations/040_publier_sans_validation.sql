-- VAL-11 : « Publier sans me demander ». Le titulaire donne son accord pour son propre compte ;
-- cet accord est tracé comme les autres consentements et retiré à la déconnexion.
ALTER TABLE account_consents DROP CONSTRAINT account_consents_kind_check;
ALTER TABLE account_consents ADD CONSTRAINT account_consents_kind_check
  CHECK (kind IN ('publish', 'store_profile', 'ai_learning', 'auto_validate'));

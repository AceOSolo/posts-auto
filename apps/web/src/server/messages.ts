/**
 * Messages affichés après une action (passés par l'adresse de la page, ce qui fonctionne
 * sans JavaScript). Seuls des codes connus sont affichés : rien de libre ne vient de l'URL.
 */
const MESSAGES: Record<string, { tone: 'success' | 'error'; text: string }> = {
  valide: { tone: 'success', text: 'Post validé.' },
  'valide-maintenant': { tone: 'success', text: 'Post validé : il part dans les minutes qui viennent.' },
  modif: { tone: 'success', text: 'Demande de modification envoyée : une nouvelle version va être préparée.' },
  refuse: { tone: 'success', text: 'Post refusé : un autre sujet va être proposé.' },
  corrige: { tone: 'success', text: 'Texte enregistré.' },
  'corrige-a-valider': { tone: 'success', text: 'Texte enregistré. Le post doit de nouveau être validé par son titulaire.' },
  replanifie: { tone: 'success', text: 'Créneau modifié.' },
  'replanifie-hors-plage': { tone: 'success', text: 'Créneau modifié. Attention : il est en dehors des horaires habituels de publication.' },
  retire: { tone: 'success', text: 'Validation retirée : le post attend de nouveau une décision.' },
  reessai: { tone: 'success', text: 'Nouvel essai de publication lancé.' },
  'compte-connecte': { tone: 'success', text: 'Profil LinkedIn connecté. Les posts validés pourront partir à leur créneau.' },
  'compte-reconnecte': { tone: 'success', text: 'Profil LinkedIn reconnecté. Les posts en attente partiront au prochain créneau possible.' },
  'compte-deconnecte': { tone: 'success', text: 'Compte déconnecté. Ses posts validés attendent de nouveau une validation.' },
  'connexion-annulee': { tone: 'error', text: 'Connexion LinkedIn annulée : rien n’a été modifié.' },
  'connexion-expiree': { tone: 'error', text: 'La demande de connexion a expiré. Recommencez depuis la page des comptes.' },
  'connexion-non-configuree': { tone: 'error', text: 'La connexion à LinkedIn n’est pas encore configurée sur ce serveur.' },
  'consentement-requis': { tone: 'error', text: 'Cochez la case d’accord pour connecter votre profil.' },
  'linkedin-erreur': { tone: 'error', text: 'LinkedIn a refusé la connexion. Réessayez dans quelques minutes.' },
  account_in_other_workspace: { tone: 'error', text: 'Ce profil LinkedIn est déjà connecté dans un autre espace.' },
  publication_non_autorisee: { tone: 'error', text: 'La permission de publier n’a pas été accordée sur LinkedIn : la connexion est annulée.' },
  envoye: { tone: 'success', text: 'Si cette adresse correspond à un compte, un lien de connexion vient d’y être envoyé. Il est valable 15 minutes.' },

  blocking_markers: { tone: 'error', text: 'Le texte contient encore [À COMPLÉTER] ou [À VÉRIFIER] : complétez-le avant de valider.' },
  note_required: { tone: 'error', text: 'Indiquez ce qu’il faut modifier.' },
  details_required: { tone: 'error', text: 'Précisez le motif du refus.' },
  transition_not_allowed: { tone: 'error', text: 'Cette action n’est plus possible : le statut du post a changé.' },
  evenement_passe: { tone: 'error', text: 'L’événement annoncé par ce post est passé : il ne peut plus être publié.' },
  plus_de_creneau: { tone: 'error', text: 'Aucun créneau libre n’a été trouvé.' },
  empty_body: { tone: 'error', text: 'Le texte ne peut pas être vide.' },
  body_too_long: { tone: 'error', text: 'Le texte dépasse 3 000 caractères, la limite de LinkedIn.' },
  not_editable: { tone: 'error', text: 'Ce post ne peut plus être corrigé ici.' },
  not_reschedulable: { tone: 'error', text: 'Le créneau de ce post ne peut plus être changé.' },
  too_soon: { tone: 'error', text: 'Choisissez un créneau à au moins 15 minutes d’ici.' },
  after_event: { tone: 'error', text: 'Ce créneau tombe après l’événement annoncé par le post.' },
  same_account_same_slot: { tone: 'error', text: 'Ce compte a déjà un post sur ce créneau.' },
  account_daily_cap: { tone: 'error', text: 'Ce compte a déjà 2 posts ce jour-là.' },
  workspace_min_gap: { tone: 'error', text: 'Un autre post de l’espace part moins de 30 minutes avant ou après.' },
  workspace_slot_cap: { tone: 'error', text: 'Trop de posts de l’espace sur ce créneau.' },
  date_invalide: { tone: 'error', text: 'Date ou heure invalide.' },
  interdit: { tone: 'error', text: 'Vous n’avez pas le droit de faire cette action sur ce post.' },
  trop: { tone: 'error', text: 'Trop de demandes de lien : réessayez dans un quart d’heure.' },
  lien: { tone: 'error', text: 'Ce lien de connexion n’est plus valable. Demandez-en un nouveau.' },
};

export function messageFor(code: string | string[] | undefined): { tone: 'success' | 'error'; text: string } | null {
  if (typeof code !== 'string') return null;
  return MESSAGES[code] ?? null;
}

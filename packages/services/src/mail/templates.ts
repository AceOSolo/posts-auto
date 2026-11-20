/**
 * Contenu des e-mails, en français. Tout contenu variable (nom de compte, motif…) est
 * échappé dans la version HTML : rien de ce qui vient des données ne peut injecter du code.
 * Chaque e-mail de notification dit comment régler ses notifications (VAL-05 : désinscription).
 */

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface TemplateContext {
  readonly appUrl: string;
  readonly recipientName: string | null;
  readonly timeZone?: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function when(iso: unknown, timeZone = 'Europe/Paris'): string {
  if (typeof iso !== 'string') return '';
  return new Intl.DateTimeFormat('fr-FR', { timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' && value !== '' ? value : fallback);
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

interface MailAction {
  readonly label: string;
  readonly url: string;
}

/** Assemble un e-mail : mêmes paragraphes en texte brut et en HTML échappé, des boutons facultatifs. */
function compose(
  ctx: TemplateContext,
  subject: string,
  paragraphs: readonly string[],
  action: MailAction | readonly MailAction[] | null,
  footer: string | null,
): RenderedMail {
  const actions: readonly MailAction[] = action === null ? [] : Array.isArray(action) ? action : [action as MailAction];
  const greeting = ctx.recipientName ? `Bonjour ${ctx.recipientName},` : 'Bonjour,';
  const text = [greeting, '', ...paragraphs.flatMap((p) => [p, '']), ...actions.flatMap((a) => [`${a.label} : ${a.url}`, '']), ...(footer ? ['—', footer] : [])].join('\n');
  const button = (a: MailAction, primary: boolean) =>
    `<a href="${escapeHtml(a.url)}" style="display:inline-block;margin:0 8px 8px 0;background:${primary ? '#df1c60' : '#ffffff'};color:${primary ? '#ffffff' : '#df1c60'};border:2px solid #df1c60;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(a.label)}</a>`;
  const html = [
    '<!doctype html><html lang="fr"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1e1a45;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">',
    `<p>${escapeHtml(greeting)}</p>`,
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    actions.length > 0 ? `<p>${actions.map((a, index) => button(a, index === 0)).join('')}</p>` : '',
    footer ? `<hr style="border:none;border-top:1px solid #eadcc3"><p style="font-size:13px;color:#4d4870">${escapeHtml(footer)}</p>` : '',
    '</body></html>',
  ].join('');
  return { subject, text, html };
}

function notificationFooter(ctx: TemplateContext): string {
  return `Vous recevez cet e-mail parce que vous participez à la publication des posts LinkedIn de votre entreprise. Pour régler vos notifications : ${ctx.appUrl}/notifications`;
}

export function loginLinkMail(ctx: TemplateContext, url: string): RenderedMail {
  return compose(
    ctx,
    'Votre lien de connexion',
    ['Voici votre lien de connexion. Il est valable 15 minutes et ne sert qu’une fois.', 'Si vous n’avez rien demandé, ignorez cet e-mail.'],
    { label: 'Se connecter', url },
    null,
  );
}

/** ONB-01 : confirmation d'une inscription (lien valable 1 heure). */
export function signupMail(ctx: TemplateContext, url: string): RenderedMail {
  return compose(
    ctx,
    'Confirmez la création de votre espace',
    [
      'Pour créer votre espace et démarrer votre essai gratuit de 14 jours, confirmez votre adresse avec le bouton ci-dessous. Le lien est valable une heure et ne sert qu’une fois.',
      'Si vous n’avez rien demandé, ignorez cet e-mail : rien ne sera créé.',
    ],
    { label: 'Créer mon espace', url },
    null,
  );
}

/** ONB-07 : invitation dans un espace, avec un lien de connexion (valable 15 minutes). */
export function invitationMail(ctx: TemplateContext, url: string, workspaceName: string, inviterName: string | null): RenderedMail {
  return compose(
    ctx,
    `Invitation : posts LinkedIn de ${workspaceName}`,
    [
      `${inviterName ?? 'Un administrateur'} vous invite à rejoindre l’espace « ${workspaceName} », où sont préparés les posts LinkedIn de votre entreprise.`,
      'Vous y recevrez les posts proposés pour votre profil, à valider, corriger ou refuser en quelques secondes depuis votre téléphone. Rien ne part sans validation.',
      'Ce lien de connexion est valable 15 minutes. Passé ce délai, demandez-en un nouveau sur la page de connexion, avec cette adresse e-mail.',
    ],
    { label: 'Rejoindre l’espace', url },
    null,
  );
}

/** E-mail d'une notification enregistrée par les tâches de fond, ou null si ce type ne s'envoie pas par e-mail. */
export function notificationMail(kind: string, payload: Record<string, unknown>, ctx: TemplateContext): RenderedMail | null {
  const account = str(payload['accountName'], 'votre compte LinkedIn');
  const footer = notificationFooter(ctx);
  const postAction = { label: 'Voir le post', url: `${ctx.appUrl}/posts/${encodeURIComponent(str(payload['postId']))}` };
  // REC-09 : lien direct vers la page des comptes de l'espace, où se trouve « Reconnecter ».
  const workspaceId = str(payload['workspaceId']);
  const accountsAction = { label: 'Reconnecter le compte', url: workspaceId ? `${ctx.appUrl}/comptes/${encodeURIComponent(workspaceId)}` : `${ctx.appUrl}/` };

  switch (kind) {
    case 'rappel_validation': {
      const hours = Number(payload['hours']);
      // VAL-06 : « Valider maintenant » sans connexion, si un lien a été préparé à l'envoi.
      const approvalUrl = str(payload['approvalUrl']);
      return compose(
        ctx,
        hours <= 3 ? `Dernier rappel : un post part dans ${hours} h` : 'Un post attend votre validation',
        [`Le post prévu sur ${account} le ${when(payload['scheduledAt'], ctx.timeZone)} n’est pas encore validé.`, 'Sans validation, il sera décalé au jour suivant, à la même heure.'],
        approvalUrl ? [{ label: 'Valider maintenant', url: approvalUrl }, { label: 'Voir et corriger', url: postAction.url }] : postAction,
        footer,
      );
    }
    case 'recap_hebdo': {
      const count = Number(payload['count']);
      return compose(
        ctx,
        `${plural(count, 'post')} à valider cette semaine`,
        [`${plural(count, 'post')} préparé${count > 1 ? 's' : ''} pour vos comptes attend${count > 1 ? 'ent' : ''} votre validation cette semaine.`, 'Quelques secondes suffisent depuis votre téléphone.'],
        { label: 'Voir mes posts', url: `${ctx.appUrl}/` },
        footer,
      );
    }
    case 'publication_erreur':
      return compose(
        ctx,
        payload['uncertain'] === true ? 'Publication incertaine : vérification nécessaire' : 'Un post n’a pas pu être publié',
        [str(payload['message'], 'La publication a échoué.')],
        postAction,
        footer,
      );
    case 'connexion_expire_bientot':
      return compose(
        ctx,
        `La connexion LinkedIn de ${account} expire bientôt`,
        [`La connexion de ${account} expire dans ${plural(Number(payload['daysLeft']), 'jour')}.`, 'Reconnectez-la en un clic pour que les posts continuent de partir.'],
        accountsAction,
        footer,
      );
    case 'connexion_expiree':
      return compose(
        ctx,
        `La connexion LinkedIn de ${account} a expiré`,
        [`Plus aucun post ne peut partir sur ${account} tant que le compte n’est pas reconnecté. Les posts validés attendent et partiront dès la reconnexion.`],
        accountsAction,
        footer,
      );
    case 'nouvelle_version':
      return compose(
        ctx,
        `Nouvelle version d’un post de ${account}`,
        [
          payload['refused'] === true
            ? 'Suite à votre refus, un autre sujet a été rédigé pour ce créneau.'
            : 'Votre demande de modification a été appliquée : la nouvelle version attend votre validation.',
          `Départ prévu le ${when(payload['scheduledAt'], ctx.timeZone)}.`,
        ],
        postAction,
        footer,
      );
    case 'generation_terminee': {
      const created = Number(payload['created']);
      const lines = [`${plural(created, 'post')} rédigé${created > 1 ? 's' : ''} et proposé${created > 1 ? 's' : ''} à la validation des titulaires.`];
      if (Number(payload['withMarkers']) > 0) lines.push(`${plural(Number(payload['withMarkers']), 'post')} porte${Number(payload['withMarkers']) > 1 ? 'nt' : ''} un marqueur à traiter avant publication.`);
      if (Number(payload['unplaced']) > 0) lines.push(`${plural(Number(payload['unplaced']), 'sujet daté')} n’a pas trouvé de créneau.`);
      if (Number(payload['suspicious']) > 0) lines.push('Des consignes cachées ont été repérées dans des contenus externes et ignorées.');
      if (Number(payload['errors']) > 0) lines.push(`${plural(Number(payload['errors']), 'post')} n’a pas pu être rédigé : voir le rapport.`);
      const runUrl = `${ctx.appUrl}/planning/${encodeURIComponent(workspaceId)}/redactions/${encodeURIComponent(str(payload['runId']))}`;
      return compose(ctx, 'Rédaction de la semaine terminée', lines, { label: 'Voir le rapport', url: runUrl }, footer);
    }
    case 'reprise_manuelle':
      return compose(
        ctx,
        `Un post de ${account} est à reprendre à la main`,
        ['Ce post a déjà été repris 3 fois sans être validé : il sort du circuit automatique et attend une reprise par l’équipe.'],
        postAction,
        footer,
      );
    case 'publication_manuelle': {
      // PUB-09 : le texte à copier, les images en pièces jointes (ajoutées à l'envoi).
      const images = Number(payload['images']) || 0;
      return compose(
        ctx,
        `À publier maintenant sur ${account}`,
        [
          `C’est l’heure prévue pour ce post validé. Copiez le texte ci-dessous et publiez-le sur ${account}${images > 0 ? `, avec ${plural(images, 'image')} jointe${images > 1 ? 's' : ''} à cet e-mail` : ''}.`,
          '———',
          ...str(payload['body']).split(/\n{2,}/),
          '———',
          'Une fois publié, vous pouvez ajouter le lien du post LinkedIn sur sa page, pour le suivi.',
        ],
        postAction,
        footer,
      );
    }
    case 'rapport_mensuel': {
      // SUI-05 : le PDF est joint à l'envoi.
      const month = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', month: 'long', year: 'numeric' }).format(new Date(str(payload['month'])));
      return compose(
        ctx,
        `Rapport LinkedIn de ${month}`,
        [`Le rapport LinkedIn de ${month} est joint à cet e-mail : posts publiés, statistiques, posts les plus engageants et enseignements du mois.`],
        { label: 'Voir le tableau de bord', url: `${ctx.appUrl}/tableau/${encodeURIComponent(workspaceId)}` },
        footer,
      );
    }
    case 'impaye': {
      // FAC-06 : relances à J+3 et J+7, suspension à J+14.
      const billingAction = { label: 'Mettre à jour le paiement', url: `${ctx.appUrl}/abonnement/${encodeURIComponent(workspaceId)}` };
      return payload['step'] === 'j14'
        ? compose(
            ctx,
            'Abonnement suspendu pour impayé',
            [
              'Le paiement de votre abonnement n’a toujours pas abouti : la rédaction et la publication des posts sont suspendues.',
              'Vos données sont conservées 90 jours. Tout reprend dès le règlement.',
            ],
            billingAction,
            footer,
          )
        : compose(
            ctx,
            'Le paiement de votre abonnement a échoué',
            [
              'Le dernier prélèvement de votre abonnement n’a pas abouti.',
              `Sans règlement, la rédaction et la publication seront suspendues ${payload['step'] === 'j7' ? 'dans 7 jours' : 'dans 11 jours'}. Vérifiez votre moyen de paiement.`,
            ],
            billingAction,
            footer,
          );
    }
    case 'quota_alerte': {
      // FAC-04, RÈG-20 : alerte à 80 %, puis au plafond.
      const full = String(payload['kind']).endsWith('_100');
      const what = String(payload['kind']).startsWith('images') ? 'images' : 'posts';
      const counts = `${String(payload['used'])} ${what} sur ${String(payload['limit'])} ce mois-ci pour ${str(payload['workspaceName'], 'votre espace')}.`;
      const next = full
        ? payload['packs'] === true
          ? 'Ajoutez un pack pour continuer ce mois-ci ; sinon, la rédaction reprend au début du mois de quota suivant.'
          : 'La rédaction reprend au début du mois de quota suivant. Les posts déjà validés partent toujours.'
        : 'Au plafond, la rédaction s’arrête jusqu’au mois suivant, sauf si vous avez choisi les packs supplémentaires.';
      return compose(
        ctx,
        full ? `Quota de ${what} du mois atteint` : `80 % du quota de ${what} utilisé`,
        [counts, next],
        { label: 'Voir l’usage', url: `${ctx.appUrl}/abonnement/${encodeURIComponent(workspaceId)}` },
        footer,
      );
    }
    default:
      return null; // ex. « post_publie », « post_replanifie » : notifications dans l'application seulement
  }
}

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

/** Assemble un e-mail : mêmes paragraphes en texte brut et en HTML échappé, un bouton facultatif. */
function compose(
  ctx: TemplateContext,
  subject: string,
  paragraphs: readonly string[],
  action: { readonly label: string; readonly url: string } | null,
  footer: string | null,
): RenderedMail {
  const greeting = ctx.recipientName ? `Bonjour ${ctx.recipientName},` : 'Bonjour,';
  const text = [greeting, '', ...paragraphs.flatMap((p) => [p, '']), ...(action ? [`${action.label} : ${action.url}`, ''] : []), ...(footer ? ['—', footer] : [])].join('\n');
  const html = [
    '<!doctype html><html lang="fr"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#17212b;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">',
    `<p>${escapeHtml(greeting)}</p>`,
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    action
      ? `<p><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#0f5b8c;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>`
      : '',
    footer ? `<hr style="border:none;border-top:1px solid #d5dde4"><p style="font-size:13px;color:#566573">${escapeHtml(footer)}</p>` : '',
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
      return compose(
        ctx,
        hours <= 3 ? `Dernier rappel : un post part dans ${hours} h` : 'Un post attend votre validation',
        [`Le post prévu sur ${account} le ${when(payload['scheduledAt'], ctx.timeZone)} n’est pas encore validé.`, 'Sans validation, il sera décalé au jour suivant, à la même heure.'],
        postAction,
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
    default:
      return null; // ex. « post_publie », « post_replanifie » : notifications dans l'application seulement
  }
}

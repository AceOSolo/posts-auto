import { describe, expect, it } from 'vitest';
import { BrevoMailer, ConsoleMailer, MailError, mailerFromEnv } from './mailer.ts';
import { escapeHtml, loginLinkMail, notificationMail } from './templates.ts';

const ctx = { appUrl: 'https://app.example', recipientName: 'Jean-Pierre', timeZone: 'Europe/Paris' };

describe('modèles d’e-mail', () => {
  it('rappel de validation : créneau en heure de Paris, lien vers le post, pied de page de désinscription', () => {
    const mail = notificationMail('rappel_validation', { postId: 'p1', accountName: 'JP', scheduledAt: '2026-11-17T11:00:00Z', hours: 3 }, ctx);
    expect(mail?.subject).toBe('Dernier rappel : un post part dans 3 h');
    expect(mail?.text).toContain('Bonjour Jean-Pierre,');
    expect(mail?.text).toContain('le mardi 17 novembre à 12:00');
    expect(mail?.text).toContain('Voir le post : https://app.example/posts/p1');
    expect(mail?.text).toContain('Pour régler vos notifications');
  });

  it('rappel avec lien de validation : « Valider maintenant » puis « Voir et corriger » (VAL-06)', () => {
    const mail = notificationMail('rappel_validation', { postId: 'p1', hours: 24, scheduledAt: '2026-11-17T11:00:00Z', approvalUrl: 'https://app.example/valider/abc' }, ctx);
    expect(mail?.text).toContain('Valider maintenant : https://app.example/valider/abc');
    expect(mail?.text).toContain('Voir et corriger : https://app.example/posts/p1');
    expect(mail?.html.indexOf('Valider maintenant')).toBeLessThan(mail?.html.indexOf('Voir et corriger') ?? 0);
  });

  it('échappe tout contenu variable dans la version HTML', () => {
    const mail = notificationMail('connexion_expiree', { accountName: '<img src=x onerror=alert(1)>' }, ctx);
    expect(mail?.html).not.toContain('<img src=x');
    expect(mail?.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  it('connexion qui expire : lien direct vers la page des comptes de l’espace (REC-09)', () => {
    const mail = notificationMail('connexion_expire_bientot', { accountName: 'JP', daysLeft: 14, workspaceId: 'ws-1' }, ctx);
    expect(mail?.text).toContain('Reconnecter le compte : https://app.example/comptes/ws-1');
  });

  it('accorde le récapitulatif au nombre de posts', () => {
    expect(notificationMail('recap_hebdo', { count: 1 }, ctx)?.subject).toBe('1 post à valider cette semaine');
    expect(notificationMail('recap_hebdo', { count: 3 }, ctx)?.subject).toBe('3 posts à valider cette semaine');
  });

  it('distingue une publication incertaine d’un échec', () => {
    expect(notificationMail('publication_erreur', { postId: 'p', uncertain: true, message: 'm' }, ctx)?.subject).toMatch(/incertaine/);
    expect(notificationMail('publication_erreur', { postId: 'p', message: 'm' }, ctx)?.subject).toMatch(/n’a pas pu/);
  });

  it('n’envoie pas par e-mail les notifications réservées à l’application', () => {
    expect(notificationMail('post_publie', {}, ctx)).toBeNull();
  });

  it('lien de connexion : bouton vers le lien, sans pied de page de notification', () => {
    const mail = loginLinkMail({ ...ctx, recipientName: null }, 'https://app.example/connexion/lien?jeton=abc');
    expect(mail.html).toContain('href="https://app.example/connexion/lien?jeton=abc"');
    expect(mail.text).not.toContain('régler vos notifications');
  });
});

describe('envoi par Brevo', () => {
  const message = { to: { email: 'jp@exemple.test', name: 'JP' }, subject: 'Objet', text: 'Texte', html: '<p>Texte</p>', tag: 'rappel_validation' };

  it('appelle l’API transactionnelle avec la clé et l’expéditeur', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = new BrevoMailer({
      apiKey: 'xkeysib-test',
      sender: { email: 'notifications@simplx.example', name: 'Rostra' },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ messageId: '<1@brevo>' }, { status: 201 });
      }) as unknown as typeof fetch,
    });
    await mailer.send(message);
    expect(calls[0]?.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((calls[0]?.init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      sender: { email: 'notifications@simplx.example', name: 'Rostra' },
      to: [{ email: 'jp@exemple.test', name: 'JP' }],
      subject: 'Objet',
      textContent: 'Texte',
      htmlContent: '<p>Texte</p>',
      tags: ['rappel_validation'],
    });
  });

  it.each([
    [500, true],
    [429, true],
    [400, false],
    [401, false],
  ])('HTTP %i → nouvel essai : %s', async (status, retryable) => {
    const mailer = new BrevoMailer({
      apiKey: 'k',
      sender: { email: 'a@b.c', name: 'x' },
      fetch: (async () => Response.json({ message: 'refusé' }, { status })) as unknown as typeof fetch,
    });
    const error = await mailer.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailError);
    expect(error).toMatchObject({ retryable });
  });

  it('Brevo injoignable : nouvel essai', async () => {
    const mailer = new BrevoMailer({
      apiKey: 'k',
      sender: { email: 'a@b.c', name: 'x' },
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(mailer.send(message)).rejects.toMatchObject({ retryable: true });
  });

  it('sans configuration Brevo, les e-mails vont dans la console', () => {
    expect(mailerFromEnv({})).toBeInstanceOf(ConsoleMailer);
    expect(mailerFromEnv({ BREVO_API_KEY: 'k', MAIL_FROM: 'a@b.c' })).toBeInstanceOf(BrevoMailer);
  });
});

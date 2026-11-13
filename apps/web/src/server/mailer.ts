/**
 * Envoi des e-mails transactionnels. En production : Brevo, avec un domaine d'envoi
 * authentifié (section 8.3). En développement : le lien s'affiche dans la console.
 */
export interface Mailer {
  sendLoginLink(to: string, url: string, expiresAt: Date): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  async sendLoginLink(to: string, url: string, expiresAt: Date): Promise<void> {
    console.info(`[e-mail] Lien de connexion pour ${to} (valable jusqu'à ${expiresAt.toISOString()}) : ${url}`);
  }
}

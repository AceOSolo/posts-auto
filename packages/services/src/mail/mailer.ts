/**
 * Envoi d'e-mails transactionnels (section 8.3) : Brevo en production, la console en
 * développement. Le domaine d'envoi doit être authentifié (SPF, DKIM, DMARC) chez Brevo.
 */

export interface MailMessage {
  readonly to: { readonly email: string; readonly name?: string | null };
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Étiquette de suivi chez Brevo (ex. « rappel_validation »). */
  readonly tag?: string;
  /** Pièces jointes (PUB-09 : images du post à publier à la main). */
  readonly attachments?: readonly { readonly name: string; readonly content: Uint8Array }[];
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class MailError extends Error {
  override readonly name = 'MailError';
  /** Échec passager (réseau, limite, indisponibilité) : un nouvel essai a du sens. */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export interface BrevoMailerOptions {
  readonly apiKey: string;
  readonly sender: { readonly email: string; readonly name: string };
  readonly fetch?: typeof fetch;
}

export const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export class BrevoMailer implements Mailer {
  readonly #options: BrevoMailerOptions;
  readonly #fetch: typeof fetch;

  constructor(options: BrevoMailerOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async send(message: MailMessage): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: { 'api-key': this.#options.apiKey, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: this.#options.sender,
          to: [{ email: message.to.email, ...(message.to.name ? { name: message.to.name } : {}) }],
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html,
          ...(message.tag ? { tags: [message.tag] } : {}),
          ...(message.attachments && message.attachments.length > 0
            ? { attachment: message.attachments.map((a) => ({ name: a.name, content: Buffer.from(a.content).toString('base64') })) }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new MailError(`Brevo injoignable : ${error instanceof Error ? error.message : String(error)}`, true);
    }
    if (!response.ok) {
      const detail = ((await response.json().catch(() => null)) as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
      throw new MailError(`Brevo a refusé l’envoi : ${detail}`, response.status === 429 || response.status >= 500);
    }
  }
}

export class ConsoleMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    const files = message.attachments?.length ? `\n[pièces jointes : ${message.attachments.map((a) => a.name).join(', ')}]` : '';
    console.info(`[e-mail] À ${message.to.email} — ${message.subject}\n${message.text}${files}\n`);
  }
}

/** Brevo si BREVO_API_KEY et MAIL_FROM sont définis, sinon la console. */
export function mailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer {
  const apiKey = env['BREVO_API_KEY'];
  const from = env['MAIL_FROM'];
  if (!apiKey || !from) return new ConsoleMailer();
  return new BrevoMailer({ apiKey, sender: { email: from, name: env['MAIL_FROM_NAME'] ?? 'Posts LinkedIn' } });
}

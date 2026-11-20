/**
 * SIT-02 : transmission des demandes de démonstration à l'éditeur : e-mail à SALES_EMAIL
 * (à défaut SUPPORT_EMAIL) et, si DEMO_WEBHOOK_URL est défini, envoi JSON au CRM (Dolibarr,
 * Make…), signé par l'en-tête X-Demo-Secret (DEMO_WEBHOOK_SECRET).
 */
import type { DemoNotifier } from '@posts-auto/services';
import { mailer } from './context.ts';

export function demoNotifier(): DemoNotifier {
  return {
    async notify(request) {
      const to = process.env['SALES_EMAIL'] ?? process.env['SUPPORT_EMAIL'];
      const lines = [
        `Nom : ${request.fullName}`,
        `Entreprise : ${request.company}`,
        `E-mail : ${request.email}`,
        `Téléphone : ${request.phone ?? '—'}`,
        `Comptes LinkedIn : ${request.accounts ?? '—'}`,
        `Message : ${request.message ?? '—'}`,
      ];
      if (to) {
        const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await mailer().send({
          to: { email: to },
          subject: `Demande de démonstration : ${request.company}`,
          text: lines.join('\n'),
          html: `<p>${lines.map(escape).join('<br>')}</p>`,
          tag: 'demande_demo',
        });
      }
      const webhook = process.env['DEMO_WEBHOOK_URL'];
      if (webhook) {
        const response = await fetch(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(process.env['DEMO_WEBHOOK_SECRET'] && { 'x-demo-secret': process.env['DEMO_WEBHOOK_SECRET'] }) },
          body: JSON.stringify({ type: 'demande_demo', ...request }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`CRM : HTTP ${response.status}`);
      }
    },
  };
}

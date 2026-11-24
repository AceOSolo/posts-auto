/** SIT-02 : transmission des demandes de démonstration à l'éditeur (e-mail, CRM). */
import { type DemoNotifier, demoNotifierFromEnv } from '@posts-auto/services';
import { mailer } from './context.ts';

export function demoNotifier(): DemoNotifier {
  return demoNotifierFromEnv(mailer());
}

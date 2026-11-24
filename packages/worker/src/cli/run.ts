/**
 * Processus des tâches de fond : npm run start -w @posts-auto/worker
 *
 * - Validation automatique : toutes les minutes, si le titulaire l'a activée (VAL-11).
 * - Publication : toutes les minutes (PUB-01 à PUB-05).
 * - Replanification : toutes les 15 minutes (RÈG-08 à RÈG-11).
 * - Connexions LinkedIn : chaque jour (LNK-04 : renouvellement, vérification, alertes).
 * - Rappels de validation et récapitulatif du lundi : toutes les 15 minutes (VAL-05).
 * - Envoi des e-mails : toutes les minutes (Brevo si BREVO_API_KEY et MAIL_FROM, sinon console).
 * - Rédaction : toutes les 5 minutes, les espaces dont la rédaction est due (GEN-01, décision 0005).
 * - Demandes de post : toutes les 5 minutes, traitées dans l'heure (IDE-06).
 * - Reprises : toutes les 5 minutes, posts « à modifier » ou « refusés » (GEN-07).
 * - Veille : toutes les heures, nouveaux articles des flux RSS des espaces (GEN-09).
 * - Apprentissage : chaque jour, préférences des titulaires tirées de leurs corrections (EDI-06).
 * - Rendez-vous récurrents : chaque jour, occurrences des 60 prochains jours (EDI-08).
 * - Statistiques LinkedIn : toutes les 6 heures, à J+1, J+7 et J+30 ; abonnés des pages (SUI-03).
 * - Bilan du mois : enseignements (SUI-04) et rapport PDF par e-mail (SUI-05), en début de mois.
 * - Facturation : toutes les heures (quantités, relances d'impayé, alertes de quota, FAC-02 à FAC-06).
 * - Visuels à refaire : toutes les minutes (VIS-13). Les visuels des nouveaux posts sont
 *   préparés avec eux par la rédaction, les demandes et les reprises (VIS-03).
 *
 * Variables d'environnement :
 * - DATABASE_URL, MEDIA_ROOT, TOKEN_ENCRYPTION_KEYS, TOKEN_ENCRYPTION_KEY_ID ;
 * - LINKEDIN_MODE : « api » (par défaut) ou « fake » (développement : rien ne part chez LinkedIn) ;
 * - LINKEDIN_API_VERSION : version AAAAMM de l'API LinkedIn (par défaut 202610) ;
 * - AI_MODE (« anthropic » ou « fake »), ANTHROPIC_API_KEY, AI_MODEL, AI_USD_TO_EUR. Sans IA
 *   configurée, les tâches qui en dépendent attendent sans rien consommer ; le reste tourne ;
 * - IMAGE_MODE : « fake » (images simulées) ; absent, pas d'image générée ;
 * - BILLING_MODE=fake (paiement simulé) ou STRIPE_SECRET_KEY.
 *
 * Journal : une ligne JSON par événement, sur la sortie standard.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isModelConfigured, modelFromEnv } from '@posts-auto/ai';
import { DEFAULT_DATABASE_URL, createDatabase } from '@posts-auto/db';
import {
  FakeLinkedIn,
  FakeLinkedInOAuth,
  FakeLinkedInStats,
  LinkedInHttpClient,
  type LinkedInOAuth,
  LinkedInOAuthClient,
  type LinkedInPublisher,
  type LinkedInStats,
  LinkedInStatsClient,
} from '@posts-auto/linkedin';
import { type BillingProvider, FakeBilling, StripeBilling, mailerFromEnv } from '@posts-auto/services';
import { type CanvaApi, CanvaConnectClient, FakeCanvaApi, imageGeneratorFromEnv } from '@posts-auto/visuals';
import { runTokenCheck } from '../accounts/token-check.ts';
import { runBillingTick } from '../billing/billing-job.ts';
import { runRequestTick } from '../generation/requests.ts';
import { runLearningTick } from '../generation/learning.ts';
import { materializeRecurringEvents } from '../generation/recurring-events.ts';
import { runReworkTick } from '../generation/reworks.ts';
import { runSourcesTick } from '../sources/sources-job.ts';
import { runMonthlyTick } from '../stats/monthly-job.ts';
import { runStatsTick } from '../stats/stats-job.ts';
import { runGenerationTick } from '../generation/weekly.ts';
import { runChatDispatch } from '../notifications/chat-dispatch.ts';
import { runEmailDispatch } from '../notifications/email-dispatch.ts';
import { runValidationReminders } from '../notifications/reminders.ts';
import { FileMediaStore } from '../media/media-store.ts';
import { runPublicationTick } from '../publication/publication.ts';
import { startScheduler } from '../runner/scheduler.ts';
import { runRescheduleTick } from '../scheduling/reschedule-job.ts';
import { TokenCipher } from '../secrets/token-cipher.ts';
import { canvaRenderer } from '../visuals/canva-renderer.ts';
import { runVisualTick } from '../visuals/visual-job.ts';
import { runAutoValidationTick } from '../validation/auto-validate.ts';

const env = process.env;
const log = (level: 'info' | 'error', event: string, details: Record<string, unknown> = {}) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ at: new Date().toISOString(), level, event, ...details }));

const db = createDatabase(env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 4 });
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const media = new FileMediaStore(env['MEDIA_ROOT'] ?? path.join(repoRoot, '.media'));
const cipher = TokenCipher.fromEnv(env);
const fake = env['LINKEDIN_MODE'] === 'fake';
const linkedin: LinkedInPublisher = fake ? new FakeLinkedIn() : new LinkedInHttpClient({ apiVersion: env['LINKEDIN_API_VERSION'] ?? '202610' });
const linkedinStats: LinkedInStats = fake ? new FakeLinkedInStats() : new LinkedInStatsClient({ apiVersion: env['LINKEDIN_API_VERSION'] ?? '202610' });
const appUrl = (env['APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
const redirectUri = `${appUrl}/comptes/connecter/retour`;
const mailer = mailerFromEnv(env);
const model = modelFromEnv(env);
const aiReady = isModelConfigured(model);
const usdToEur = Number.parseFloat(env['AI_USD_TO_EUR'] ?? '0.86');
const images = imageGeneratorFromEnv(env);
const billing: BillingProvider | null =
  env['BILLING_MODE'] === 'fake' ? new FakeBilling(appUrl) : env['STRIPE_SECRET_KEY'] ? new StripeBilling({ secretKey: env['STRIPE_SECRET_KEY'] }) : null;
// VIS-07 : Canva du client (CANVA_CLIENT_ID, CANVA_CLIENT_SECRET), ou simulé (CANVA_MODE=fake).
const canvaApi: CanvaApi | null =
  env['CANVA_MODE'] === 'fake'
    ? new FakeCanvaApi(appUrl)
    : env['CANVA_CLIENT_ID'] && env['CANVA_CLIENT_SECRET']
      ? new CanvaConnectClient({ clientId: env['CANVA_CLIENT_ID'], clientSecret: env['CANVA_CLIENT_SECRET'] })
      : null;
// Rédaction avec visuels (1c) : les posts sont déposés avec leur visuel.
const writing = { db, model, usdToEur, media, images, canva: canvaApi === null ? null : canvaRenderer(db, canvaApi, cipher) };
const oauth: LinkedInOAuth | null = fake
  ? new FakeLinkedInOAuth(redirectUri)
  : env['LINKEDIN_CLIENT_ID'] && env['LINKEDIN_CLIENT_SECRET']
    ? new LinkedInOAuthClient({ clientId: env['LINKEDIN_CLIENT_ID'], clientSecret: env['LINKEDIN_CLIENT_SECRET'], redirectUri })
    : null;

log('info', 'demarrage', {
  linkedin: env['LINKEDIN_MODE'] === 'fake' ? 'faux (développement)' : 'API',
  ia: model.provider === 'simulation' ? 'simulée (développement)' : aiReady ? model.model : 'non configurée',
  images: images === null ? 'aucune image générée' : images.provider,
  paiement: billing === null ? 'non configuré' : billing.name,
  cle: cipher.currentKeyId,
});
if (!aiReady) log('error', 'ia_non_configuree', { effet: 'rédaction, demandes, reprises, visuels et apprentissage en attente', action: 'renseigner AI_MODE=anthropic et ANTHROPIC_API_KEY' });

const scheduler = startScheduler(
  [
    { name: 'validation-auto', intervalMs: 60_000, run: () => runAutoValidationTick({ db }) },
    { name: 'publication', intervalMs: 60_000, run: () => runPublicationTick({ db, linkedin, media, cipher }) },
    { name: 'replanification', intervalMs: 15 * 60_000, run: () => runRescheduleTick({ db }) },
    { name: 'connexions', intervalMs: 24 * 3_600_000, run: () => runTokenCheck({ db, oauth, cipher }) },
    { name: 'rappels', intervalMs: 15 * 60_000, run: () => runValidationReminders({ db }) },
    { name: 'e-mails', intervalMs: 60_000, run: () => runEmailDispatch({ db, mailer, appUrl, media }) },
    { name: 'messagerie', intervalMs: 60_000, run: () => runChatDispatch({ db, cipher, appUrl }) },
    // Sans IA, ces tâches attendent : les lancer marquerait demandes et reprises en échec définitif.
    ...(aiReady
      ? [
          { name: 'redaction', intervalMs: 5 * 60_000, run: () => runGenerationTick(writing) },
          { name: 'demandes', intervalMs: 5 * 60_000, run: () => runRequestTick(writing) },
          { name: 'reprises', intervalMs: 5 * 60_000, run: () => runReworkTick(writing) },
          { name: 'visuels', intervalMs: 60_000, run: () => runVisualTick(writing) },
          { name: 'apprentissage', intervalMs: 24 * 3_600_000, run: () => runLearningTick({ db, model, usdToEur }) },
        ]
      : []),
    { name: 'facturation', intervalMs: 60 * 60_000, run: () => runBillingTick({ db, provider: billing, media }) },
    { name: 'statistiques', intervalMs: 6 * 3_600_000, run: () => runStatsTick({ db, stats: linkedinStats, cipher }) },
    { name: 'bilan-mensuel', intervalMs: 6 * 3_600_000, run: () => runMonthlyTick({ db }) },
    { name: 'veille', intervalMs: 60 * 60_000, run: () => runSourcesTick({ db }) },
    { name: 'evenements', intervalMs: 24 * 3_600_000, run: async () => ({ crees: await materializeRecurringEvents(db, new Date()) }) },
  ],
  { info: (event, details) => log('info', event, details), error: (event, details) => log('error', event, details) },
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log('info', 'arret', { signal });
  await scheduler.stop();
  await db.destroy();
  log('info', 'arrete');
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

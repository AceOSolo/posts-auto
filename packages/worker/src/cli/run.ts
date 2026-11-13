/**
 * Processus des tâches de fond : npm run start -w @posts-auto/worker
 *
 * - Publication : toutes les minutes (PUB-01 à PUB-05).
 * - Replanification : toutes les 15 minutes (RÈG-08 à RÈG-11).
 * - Connexions LinkedIn : chaque jour (LNK-04 : renouvellement, vérification, alertes).
 * - Rappels de validation et récapitulatif du lundi : toutes les 15 minutes (VAL-05).
 * - Envoi des e-mails : toutes les minutes (Brevo si BREVO_API_KEY et MAIL_FROM, sinon console).
 *
 * Variables d'environnement :
 * - DATABASE_URL, MEDIA_ROOT, TOKEN_ENCRYPTION_KEYS, TOKEN_ENCRYPTION_KEY_ID ;
 * - LINKEDIN_MODE : « api » (par défaut) ou « fake » (développement : rien ne part chez LinkedIn) ;
 * - LINKEDIN_API_VERSION : version AAAAMM de l'API LinkedIn (par défaut 202610).
 *
 * Journal : une ligne JSON par événement, sur la sortie standard.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATABASE_URL, createDatabase } from '@posts-auto/db';
import {
  FakeLinkedIn,
  FakeLinkedInOAuth,
  LinkedInHttpClient,
  type LinkedInOAuth,
  LinkedInOAuthClient,
  type LinkedInPublisher,
} from '@posts-auto/linkedin';
import { mailerFromEnv } from '@posts-auto/services';
import { runTokenCheck } from '../accounts/token-check.ts';
import { runEmailDispatch } from '../notifications/email-dispatch.ts';
import { runValidationReminders } from '../notifications/reminders.ts';
import { FileMediaStore } from '../media/media-store.ts';
import { runPublicationTick } from '../publication/publication.ts';
import { startScheduler } from '../runner/scheduler.ts';
import { runRescheduleTick } from '../scheduling/reschedule-job.ts';
import { TokenCipher } from '../secrets/token-cipher.ts';

const env = process.env;
const log = (level: 'info' | 'error', event: string, details: Record<string, unknown> = {}) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ at: new Date().toISOString(), level, event, ...details }));

const db = createDatabase(env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL, { maxConnections: 4 });
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const media = new FileMediaStore(env['MEDIA_ROOT'] ?? path.join(repoRoot, '.media'));
const cipher = TokenCipher.fromEnv(env);
const fake = env['LINKEDIN_MODE'] === 'fake';
const linkedin: LinkedInPublisher = fake ? new FakeLinkedIn() : new LinkedInHttpClient({ apiVersion: env['LINKEDIN_API_VERSION'] ?? '202610' });
const appUrl = (env['APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
const redirectUri = `${appUrl}/comptes/connecter/retour`;
const mailer = mailerFromEnv(env);
const oauth: LinkedInOAuth | null = fake
  ? new FakeLinkedInOAuth(redirectUri)
  : env['LINKEDIN_CLIENT_ID'] && env['LINKEDIN_CLIENT_SECRET']
    ? new LinkedInOAuthClient({ clientId: env['LINKEDIN_CLIENT_ID'], clientSecret: env['LINKEDIN_CLIENT_SECRET'], redirectUri })
    : null;

log('info', 'demarrage', { linkedin: env['LINKEDIN_MODE'] === 'fake' ? 'faux (développement)' : 'API', cle: cipher.currentKeyId });

const scheduler = startScheduler(
  [
    { name: 'publication', intervalMs: 60_000, run: () => runPublicationTick({ db, linkedin, media, cipher }) },
    { name: 'replanification', intervalMs: 15 * 60_000, run: () => runRescheduleTick({ db }) },
    { name: 'connexions', intervalMs: 24 * 3_600_000, run: () => runTokenCheck({ db, oauth, cipher }) },
    { name: 'rappels', intervalMs: 15 * 60_000, run: () => runValidationReminders({ db }) },
    { name: 'e-mails', intervalMs: 60_000, run: () => runEmailDispatch({ db, mailer, appUrl }) },
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

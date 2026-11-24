/**
 * Ressources partagées du serveur web : base, médias, e-mails. Une seule instance par
 * processus, conservée à travers les rechargements à chaud du mode développement.
 */
import path from 'node:path';
import { type TextModel, modelFromEnv } from '@posts-auto/ai';
import { DEFAULT_DATABASE_URL, type Database, createDatabase } from '@posts-auto/db';
import { FakeLinkedInOAuth, FakeLinkedInPages, type LinkedInOAuth, LinkedInOAuthClient, type LinkedInPages, LinkedInPagesClient } from '@posts-auto/linkedin';
import { FileMediaStore, type MediaStore, TokenCipher } from '@posts-auto/worker';
import { type CanvaApi, CanvaConnectClient, FakeCanvaApi } from '@posts-auto/visuals';
import { type BillingProvider, FakeBilling, FakeSsoProvider, type Mailer, type SsoProvider, StripeBilling, googleProvider, mailerFromEnv, microsoftProvider } from '@posts-auto/services';

interface ServerResources {
  db?: Database;
  media?: MediaStore;
  mailer?: Mailer;
  model?: TextModel;
}

const resources = ((globalThis as { __postsAuto?: ServerResources }).__postsAuto ??= {});

export function database(): Database {
  resources.db ??= createDatabase(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL);
  return resources.db;
}

export function mediaStore(): MediaStore {
  // En développement, dossier « .media » à la racine du dépôt, partagé avec les tâches de fond.
  resources.media ??= new FileMediaStore(process.env['MEDIA_ROOT'] ?? path.resolve(process.cwd(), '../../.media'));
  return resources.media;
}

export function mailer(): Mailer {
  // Brevo si BREVO_API_KEY et MAIL_FROM sont définis, sinon la console.
  resources.mailer ??= mailerFromEnv(process.env);
  return resources.mailer;
}

/**
 * Connexion LinkedIn : application LinkedIn A (LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET),
 * ou mode simulé (LINKEDIN_MODE=fake). Null tant que rien n'est configuré.
 */
export function linkedinOAuth(): LinkedInOAuth | null {
  const redirectUri = `${appUrl()}/comptes/connecter/retour`;
  if (process.env['LINKEDIN_MODE'] === 'fake') return new FakeLinkedInOAuth(redirectUri);
  const clientId = process.env['LINKEDIN_CLIENT_ID'];
  const clientSecret = process.env['LINKEDIN_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;
  return new LinkedInOAuthClient({ clientId, clientSecret, redirectUri });
}

/** LNK-02 : pages administrées (Community Management API), ou simulées (LINKEDIN_MODE=fake). */
export function linkedinPages(): LinkedInPages {
  if (process.env['LINKEDIN_MODE'] === 'fake') return new FakeLinkedInPages();
  return new LinkedInPagesClient({ apiVersion: process.env['LINKEDIN_API_VERSION'] ?? '202610' });
}

/**
 * Paiement (FAC-01) : Stripe (STRIPE_SECRET_KEY), ou simulé (BILLING_MODE=fake : aucune
 * somme n'est prélevée). Null tant que rien n'est configuré.
 */
export function billing(): BillingProvider | null {
  if (billingSimulated()) return new FakeBilling(appUrl());
  const secretKey = process.env['STRIPE_SECRET_KEY'];
  return secretKey ? new StripeBilling({ secretKey }) : null;
}

export function billingSimulated(): boolean {
  return process.env['BILLING_MODE'] === 'fake';
}

/**
 * ONB-01 : connexion avec Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) ou Microsoft
 * (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET), ou simulée (SSO_MODE=fake).
 */
export function ssoProviders(): SsoProvider[] {
  if (process.env['SSO_MODE'] === 'fake') return [new FakeSsoProvider('google', appUrl()), new FakeSsoProvider('microsoft', appUrl())];
  const providers: SsoProvider[] = [];
  const env = process.env;
  if (env['GOOGLE_CLIENT_ID'] && env['GOOGLE_CLIENT_SECRET']) providers.push(googleProvider(env['GOOGLE_CLIENT_ID'], env['GOOGLE_CLIENT_SECRET']));
  if (env['MICROSOFT_CLIENT_ID'] && env['MICROSOFT_CLIENT_SECRET']) providers.push(microsoftProvider(env['MICROSOFT_CLIENT_ID'], env['MICROSOFT_CLIENT_SECRET']));
  return providers;
}

/** VIS-07 : Canva (CANVA_CLIENT_ID, CANVA_CLIENT_SECRET), ou simulé (CANVA_MODE=fake). */
export function canvaApi(): CanvaApi | null {
  if (process.env['CANVA_MODE'] === 'fake') return new FakeCanvaApi(appUrl());
  const id = process.env['CANVA_CLIENT_ID'];
  const secret = process.env['CANVA_CLIENT_SECRET'];
  return id && secret ? new CanvaConnectClient({ clientId: id, clientSecret: secret }) : null;
}

/** Chiffrement des jetons (SEC-02) ; null si les clés ne sont pas configurées. */
export function tokenCipher(): TokenCipher | null {
  try {
    return TokenCipher.fromEnv(process.env);
  } catch {
    return null;
  }
}

/** Adresse publique de l'application, pour les liens envoyés par e-mail. */
export function appUrl(): string {
  return (process.env['APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

/** Modèle d'IA (AI_MODE, ANTHROPIC_API_KEY, AI_MODEL) ; simulé seulement avec AI_MODE=fake. */
export function model(): TextModel {
  resources.model ??= modelFromEnv(process.env);
  return resources.model;
}

/** Conversion du coût de l'IA en euros (GEN-11). */
export function usdToEur(): number {
  const rate = Number.parseFloat(process.env['AI_USD_TO_EUR'] ?? '');
  return Number.isFinite(rate) && rate > 0 ? rate : 0.86;
}

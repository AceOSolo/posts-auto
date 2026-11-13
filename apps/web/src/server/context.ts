/**
 * Ressources partagées du serveur web : base, médias, e-mails. Une seule instance par
 * processus, conservée à travers les rechargements à chaud du mode développement.
 */
import path from 'node:path';
import { type TextModel, modelFromEnv } from '@posts-auto/ai';
import { DEFAULT_DATABASE_URL, type Database, createDatabase } from '@posts-auto/db';
import { FakeLinkedInOAuth, type LinkedInOAuth, LinkedInOAuthClient } from '@posts-auto/linkedin';
import { FileMediaStore, type MediaStore, TokenCipher } from '@posts-auto/worker';
import { type Mailer, mailerFromEnv } from '@posts-auto/services';

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

/** Modèle d'IA (AI_MODE, ANTHROPIC_API_KEY, AI_MODEL) ; simulé sans configuration. */
export function model(): TextModel {
  resources.model ??= modelFromEnv(process.env);
  return resources.model;
}

/** Conversion du coût de l'IA en euros (GEN-11). */
export function usdToEur(): number {
  const rate = Number.parseFloat(process.env['AI_USD_TO_EUR'] ?? '');
  return Number.isFinite(rate) && rate > 0 ? rate : 0.86;
}

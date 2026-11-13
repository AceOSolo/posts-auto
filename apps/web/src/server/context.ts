/**
 * Ressources partagées du serveur web : base, médias, e-mails. Une seule instance par
 * processus, conservée à travers les rechargements à chaud du mode développement.
 */
import { DEFAULT_DATABASE_URL, type Database, createDatabase } from '@posts-auto/db';
import { FileMediaStore, type MediaStore } from '@posts-auto/worker';
import { ConsoleMailer, type Mailer } from './mailer.ts';

interface ServerResources {
  db?: Database;
  media?: MediaStore;
  mailer?: Mailer;
}

const resources = ((globalThis as { __postsAuto?: ServerResources }).__postsAuto ??= {});

export function database(): Database {
  resources.db ??= createDatabase(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL);
  return resources.db;
}

export function mediaStore(): MediaStore {
  resources.media ??= new FileMediaStore(process.env['MEDIA_ROOT'] ?? '.media');
  return resources.media;
}

export function mailer(): Mailer {
  resources.mailer ??= new ConsoleMailer();
  return resources.mailer;
}

/** Adresse publique de l'application, pour les liens envoyés par e-mail. */
export function appUrl(): string {
  return (process.env['APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Ressources partagées du serveur web : base, médias, e-mails. Une seule instance par
 * processus, conservée à travers les rechargements à chaud du mode développement.
 */
import path from 'node:path';
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
  // En développement, dossier « .media » à la racine du dépôt, partagé avec les tâches de fond.
  resources.media ??= new FileMediaStore(process.env['MEDIA_ROOT'] ?? path.resolve(process.cwd(), '../../.media'));
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

/**
 * Mise en place des tests de @posts-auto/db : une base neuve, migrée, propre à cette
 * exécution, supprimée à la fin. Les tests ne touchent jamais la base de développement.
 */
import type { TestProject } from 'vitest/node';
import { createMigratedTempDatabase } from './temp-database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const temp = await createMigratedTempDatabase('posts_auto_test');
  project.provide('databaseUrl', temp.url);
  return () => temp.drop();
}

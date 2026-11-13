/**
 * Mise en place des tests qui utilisent la base : une base neuve, migrée, propre à cette
 * exécution, supprimée à la fin. Les tests ne touchent jamais la base de développement.
 */
import type { TestProject } from 'vitest/node';
import './provided-context.js';
import { createMigratedTempDatabase } from './temp-database.js';

export default async function setup(project: TestProject) {
  const temp = await createMigratedTempDatabase('posts_auto_test');
  project.provide('databaseUrl', temp.url);
  return () => temp.drop();
}

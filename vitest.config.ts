import { defineConfig } from 'vitest/config';

// Les règles de créneaux dépendent du fuseau : on force un fuseau machine différent
// de Europe/Paris pour prouver que le code n'en dépend pas.
const env = { TZ: 'America/New_York' };

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'core', include: ['packages/core/src/**/*.test.ts'], env },
      },
      {
        test: {
          name: 'db',
          include: ['packages/db/src/**/*.test.ts'],
          env,
          // Base PostgreSQL jetable : nécessite `docker compose up -d --wait`.
          globalSetup: ['packages/db/src/testing/global-setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/testing/**', '**/testing.ts', '**/generated/**', '**/cli/**'],
      // NF-12 : couverture ≥ 80 % sur les règles métier et la publication.
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});

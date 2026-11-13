import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Les règles de créneaux dépendent du fuseau : on force un fuseau machine
    // différent de Europe/Paris pour prouver que le code n'en dépend pas.
    env: { TZ: 'America/New_York' },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      // NF-12 : couverture ≥ 80 % sur les règles métier et la publication.
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});

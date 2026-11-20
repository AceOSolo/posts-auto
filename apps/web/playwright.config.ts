/**
 * Tests dans un vrai navigateur (Chromium), sur l'application lancée et les données de
 * démonstration : npm run e2e -w @posts-auto/web (APP_URL : adresse de l'application).
 * Deux tailles d'écran : ordinateur et téléphone (la validation se fait surtout sur mobile).
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env['APP_URL'] ?? 'http://localhost:3000',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'ordinateur', use: { ...devices['Desktop Chrome'] } },
    { name: 'telephone', use: { ...devices['Pixel 7'] } },
  ],
});

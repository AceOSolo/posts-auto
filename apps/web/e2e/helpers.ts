import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Page, expect } from '@playwright/test';

export interface Sessions {
  readonly jp: string;
  readonly alexis: string;
  readonly claire: string;
  readonly workspaceId: string;
  readonly pageAccountId: string;
}

export const sessions = (): Sessions => JSON.parse(readFileSync(new URL('./.sessions.json', import.meta.url), 'utf8')) as Sessions;

/** Session de la personne : cookie de développement et cookie de production (« __Host- »). */
export async function signIn(context: BrowserContext, baseURL: string, token: string): Promise<void> {
  const url = new URL(baseURL);
  await context.addCookies([
    { name: 'session', value: token, domain: url.hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
    { name: '__Host-session', value: token, domain: url.hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
}

/** NF-08 : aucune violation d'accessibilité grave (WCAG 2.1 AA) relevée par axe. */
export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id} : ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

/** Pas de défilement horizontal : la page tient dans la largeur de l'écran. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

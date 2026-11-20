import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, sessions, signIn } from './helpers.ts';

test.describe('application (VAL, PLA, VIS, SUI)', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL as string, sessions().jp);
  });

  test('« Mes posts » : posts à valider, phrase de départ ; accessible, tient sur l’écran', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Mes posts' })).toBeVisible();
    await expect(page.getByText(/Partira .* si validé/).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page);
  });

  test('détail d’un post : le marqueur à compléter bloque la validation', async ({ page }) => {
    await page.goto('/');
    // La carte du post qui contient un passage à compléter.
    const card = page.locator('article, li').filter({ hasText: 'passage à compléter' }).first();
    await card.getByRole('link', { name: /Voir et corriger|Voir le détail/ }).click();
    await expect(page.locator('.marker').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Valider/ }).first()).toBeDisabled();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page);
  });

  test('valider un post depuis son détail', async ({ page }) => {
    await page.goto('/');
    const links = page.locator('a[href^="/posts/"]');
    const count = await links.count();
    for (let i = 0; i < count; i += 1) {
      await page.goto('/');
      await page.locator('a[href^="/posts/"]').nth(i).click();
      const validate = page.getByRole('button', { name: /^Valider/ }).first();
      if ((await validate.count()) > 0 && (await validate.isEnabled())) {
        await validate.click();
        await expect(page.getByText(/Post validé/)).toBeVisible();
        return;
      }
    }
    test.skip(true, 'aucun post validable dans les données de démonstration');
  });
});

test.describe('pages de gestion (administratrice)', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL as string, sessions().alexis);
  });

  for (const [name, path] of [
    ['tableau de bord', 'tableau'],
    ['planning', 'planning'],
    ['comptes', 'comptes'],
    ['ligne éditoriale', 'ligne'],
    ['visuels', 'visuels'],
    ['réglages', 'espace'],
    ['abonnement', 'abonnement'],
  ] as const) {
    test(`${name} : s’affiche, accessible, tient sur l’écran`, async ({ page }) => {
      const response = await page.goto(`/${path}/${sessions().workspaceId}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectAccessible(page);
    });
  }

  test('navigation : liens principaux présents', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
  });
});

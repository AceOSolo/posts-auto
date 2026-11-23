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
    await card.getByRole('link', { name: /^Modifier$|Voir le détail/ }).click();
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
    ['démarrage', 'demarrage'],
  ] as const) {
    test(`${name} : s’affiche, accessible, tient sur l’écran`, async ({ page }) => {
      const response = await page.goto(`/${path}/${sessions().workspaceId}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectAccessible(page);
    });
  }

  test('fiche d’un compte : meilleurs moments pour publier, ajout du créneau proposé', async ({ page }) => {
    await page.goto(`/comptes/${sessions().workspaceId}/fiche/${sessions().pageAccountId}`);
    await expect(page.getByRole('heading', { name: 'Meilleurs moments pour publier' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page);
    const add = page.getByRole('button', { name: /^Ajouter le créneau du mardi/ });
    if ((await add.count()) > 0) {
      await add.click();
      await expect(page.getByText(/Créneau ajouté aux créneaux habituels/)).toBeVisible();
    }
    await expect(page.getByText('Un créneau habituel est déjà placé à ce moment.')).toBeVisible();
  });

  test('navigation : liens principaux présents', async ({ page }) => {
    await page.goto('/');
    const menu = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(menu).toBeVisible();
    await expect(page.locator('.side-link')).toHaveText([/Valider/, /Créer/, /Équipe/, /Paramètres/, /Mon compte/]);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page);
  });

  test('navigation : un seul menu, chaque page de chaque rubrique s’ouvre', async ({ page }) => {
    test.setTimeout(180_000);
    const rubriques: [RegExp, string[]][] = [
      [/Créer/, ['Planning', 'Idées', 'Visuels']],
      [/Équipe/, ['Membres', 'Comptes LinkedIn', 'Vue équipe', 'Tableau de bord']],
      [/Paramètres/, ['Ligne éditoriale', 'Intégrations et support', 'Abonnement', 'Démarrage']],
      [/Mon compte/, ['Données et sécurité', 'Notifications']],
    ];
    await page.goto('/');
    // Pages de la rubrique : sous la rubrique sur ordinateur, en onglets sur téléphone.
    const pages = page.locator('.side-sub:visible, .mobile-tabs:visible');
    for (const [rubrique, onglets] of rubriques) {
      await page.locator('.side-link').filter({ hasText: rubrique }).click();
      await expect(pages).toBeVisible({ timeout: 20_000 });
      for (const onglet of onglets) {
        const lien = pages.getByRole('link', { name: new RegExp(`^${onglet}`) });
        await lien.click();
        await expect(lien).toHaveAttribute('aria-current', 'page', { timeout: 20_000 });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectNoHorizontalScroll(page);
      }
    }
  });

  test('planning : un seul menu, les outils sont repliés', async ({ page }) => {
    await page.goto(`/planning/${sessions().workspaceId}`);
    await expect(page.getByRole('navigation', { name: 'Planning', exact: true })).toHaveCount(0);
    const outils = page.locator('.page-menu');
    await expect(outils.getByRole('link', { name: 'Vue de la semaine' })).toBeHidden();
    await outils.locator('summary').click();
    await outils.getByRole('link', { name: 'Vue de la semaine' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /semaine/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.side-sub:visible, .mobile-tabs:visible').getByRole('link', { name: 'Planning' })).toHaveAttribute('aria-current', 'page');
  });

  test('idées : événements et banque de sujets rangés sous Idées', async ({ page }) => {
    await page.goto(`/idees/${sessions().workspaceId}`);
    const outils = page.locator('.page-menu');
    await outils.locator('summary').click();
    await outils.getByRole('link', { name: 'Banque de sujets' }).click();
    await expect(page.getByRole('heading', { name: 'Banque de sujets' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.side-sub:visible, .mobile-tabs:visible').getByRole('link', { name: 'Idées' })).toHaveAttribute('aria-current', 'page');
  });
});

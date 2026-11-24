import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll } from './helpers.ts';

test.describe('site vitrine (SIT-01 à SIT-09)', () => {
  test('page d’accueil : promesse, étapes, tarifs, FAQ, appels à l’action ; accessible et sans défilement horizontal', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Comment ça marche' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Questions fréquentes' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Essai gratuit/ }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page);
  });

  test('simulateur de prix sans JavaScript', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Profils LinkedIn').fill('4');
    await page.getByLabel('Pages d’entreprise').fill('2');
    await page.getByRole('button', { name: 'Calculer' }).click();
    await expect(page.getByText('Pour 6 comptes')).toBeVisible();
  });

  test('demande de démonstration : message de confirmation', async ({ page }) => {
    await page.goto('/#demo');
    await page.getByLabel('Nom', { exact: true }).fill('Prospect Navigateur');
    await page.getByLabel('Entreprise', { exact: true }).fill('Prospect SAS');
    await page.getByLabel('E-mail professionnel').fill(`navigateur-${Date.now()}@demo.example.test`);
    await page.getByRole('button', { name: 'Envoyer la demande' }).click();
    await expect(page.getByText(/votre demande est envoyée/)).toBeVisible();
  });

  test('démonstration de validation : bloquée sans l’information, puis publiée', async ({ page }) => {
    await page.goto('/');
    const essai = page.getByRole('figure', { name: /Démonstration : valider un post/ });
    const champ = essai.getByLabel('Nombre d’entreprises');
    await expect(champ).toBeEnabled();
    await essai.getByRole('button', { name: 'Valider' }).click();
    await expect(essai.getByRole('status')).toContainText('Bloqué');
    await champ.fill('40');
    await essai.getByRole('button', { name: 'Valider' }).click();
    await expect(essai.getByRole('status')).toHaveText('Publié.');
    await essai.getByRole('button', { name: 'Recommencer' }).click();
    await expect(champ).toHaveValue('');
  });

  test('version anglaise et pages légales', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'English' }).click();
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'English' })).toBeHidden();
    await expectNoHorizontalScroll(page);
    for (const path of ['/mentions-legales', '/cgu', '/cgv', '/confidentialite', '/cookies', '/sous-traitants']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    await expectAccessible(page);
  });

  test('pages tarifs, PME et ETI, agences, confiance : indexables, accessibles, sans défilement horizontal', async ({ page }) => {
    for (const path of ['/tarifs', '/pme-eti', '/agences', '/confiance']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${path}$`));
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page);
    }
  });

  test('connexion et inscription : formulaires accessibles', async ({ page }) => {
    await page.goto('/connexion');
    await expect(page.getByLabel('Adresse e-mail professionnelle')).toBeVisible();
    await expectAccessible(page);
    await page.goto('/inscription');
    await expect(page.getByRole('button', { name: 'Recevoir mon lien de confirmation' })).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);
  });
});

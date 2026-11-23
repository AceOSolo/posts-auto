import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, sessions, signIn } from './helpers.ts';

test('journées suggérées (PLA-10) : ajout en un clic puis retrait', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL as string, sessions().alexis);
  await page.goto(`/planning/${sessions().workspaceId}/evenements`);

  const section = page.getByRole('region', { name: /Journées à venir/ });
  const add = section.getByRole('button', { name: /^Ajouter : / }).first();
  const label = (await add.getAttribute('aria-label')) as string;
  const title = label.replace('Ajouter : ', '');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page);

  await add.click();
  await expect(page.getByText('Journée ajoutée à vos événements')).toBeVisible();
  await expect(section.getByRole('button', { name: label })).toHaveCount(0);

  // Le test rend les données de démonstration dans leur état de départ.
  const card = page.locator('li.card', { has: page.getByRole('heading', { level: 2, name: title }) });
  await expect(card.locator('.badge', { hasText: 'Chaque année' })).toBeVisible();
  await card.getByRole('button', { name: 'Supprimer l’événement' }).click();
  await expect(page.getByText('Événement supprimé')).toBeVisible();
  await expect(section.getByRole('button', { name: label })).toBeVisible();
});

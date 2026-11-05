/**
 * How it works (the "where does this data come from, and what do I have to run?" page). Like
 * Methodology it is a shipped Markdown file rendered by our own subset renderer, so the tests
 * check the rendering and the promises the page makes about being automatic.
 */
import { expect, test } from '@playwright/test';
import { assertNoProblems, expectNoAxeViolations, openRoute, watchForProblems } from './helpers.js';

test.describe('how it works', () => {
  test('renders the shipped document', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, '/how-it-works');

    await expect(page.getByRole('heading', { level: 1, name: 'How it works' })).toBeVisible();
    await expect(page).toHaveTitle(/^How it works · AI Cost Analyzer$/);

    for (const name of [
      /Where the numbers come from/,
      /When the index updates/,
      /What is computed, and when/,
      /How insights are generated/,
      /Privacy/,
    ]) {
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    }

    // The two answers the page exists to give, in the words the reader asked the question in.
    await expect(page.getByText(/quiet for 3 seconds/).first()).toBeVisible();
    await expect(page.getByText(/No AI model is involved/).first()).toBeVisible();

    assertNoProblems(problems, '/how-it-works');
  });

  test('the contents list jumps to a section', async ({ page }) => {
    await openRoute(page, '/how-it-works');
    const nav = page.getByRole('navigation', { name: 'Contents' });
    await expect(nav.getByRole('link')).toHaveCount(6);
    const first = nav.getByRole('link').first();
    const href = await first.getAttribute('href');
    expect(href).toMatch(/^#.+/);
    await first.click();
    await expect(page.locator(href as string)).toBeVisible();
  });

  test('links to methodology without leaving the app', async ({ page }) => {
    await openRoute(page, '/how-it-works');
    await page.locator('article').getByRole('link', { name: 'Methodology' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Methodology' })).toBeVisible();
  });

  test('is reachable from the rail and the g w shortcut', async ({ page }) => {
    await openRoute(page, '/');
    await page.getByRole('link', { name: 'How it works', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'How it works' })).toBeVisible();

    await openRoute(page, '/');
    await page.keyboard.press('g');
    await page.keyboard.press('w');
    await expect(page.getByRole('heading', { level: 1, name: 'How it works' })).toBeVisible();
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    await openRoute(page, '/how-it-works');
    await expectNoAxeViolations(page, '/how-it-works');
  });
});

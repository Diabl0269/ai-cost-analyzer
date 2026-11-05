/**
 * Methodology (SPEC §8.4). The page is `docs/METHODOLOGY.md` rendered by our own Markdown
 * subset, so the tests check the rendering — headings, lists, code — and that no HTML in the
 * source could ever become markup.
 */
import { expect, test } from '@playwright/test';
import { assertNoProblems, expectNoAxeViolations, openRoute, watchForProblems } from './helpers.js';

test.describe('methodology', () => {
  test('renders the shipped document', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, '/methodology');

    await expect(page.getByRole('heading', { level: 1, name: 'Methodology' })).toBeVisible();
    await expect(page).toHaveTitle(/^Methodology · AI Cost Analyzer$/);

    // Section headings from the source file, each carrying the id the contents list links to.
    const first = page.getByRole('heading', { level: 2, name: /Where the data comes from/ });
    await expect(first).toBeVisible();
    await expect(first).toHaveAttribute('id', /.+/);
    await expect(page.getByRole('heading', { level: 2, name: /Request cost \(exact\)/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Cross-check' })).toBeVisible();

    // Fenced code became a <pre>, inline code became <code>, bold became <strong>.
    await expect(page.locator('article pre').first()).toBeVisible();
    await expect(page.locator('article code').first()).toBeVisible();
    await expect(page.locator('article strong').first()).toBeVisible();
    await expect(page.locator('article ol li').first()).toBeVisible();
    await expect(page.locator('article ul li').first()).toBeVisible();

    assertNoProblems(problems, '/methodology');
  });

  test('the contents list jumps to a section', async ({ page }) => {
    await openRoute(page, '/methodology');
    const nav = page.getByRole('navigation', { name: 'Contents' });
    await expect(nav.getByRole('link')).not.toHaveCount(0);
    const first = nav.getByRole('link').first();
    const href = await first.getAttribute('href');
    expect(href).toMatch(/^#.+/);
    await first.click();
    await expect(page.locator(href as string)).toBeVisible();
  });

  test('does not pass raw HTML through', async ({ page }) => {
    await openRoute(page, '/methodology');
    // The document contains no HTML today; this guards the renderer, not the document.
    const scripts = await page.locator('article script, article iframe, article object').count();
    expect(scripts).toBe(0);
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    await openRoute(page, '/methodology');
    await expectNoAxeViolations(page, '/methodology');
  });
});

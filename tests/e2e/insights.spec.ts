/**
 * Insights (SPEC §10.3): every finding the API returns is on the page, grouped by kind and
 * carrying its money impact.
 */
import { expect, test } from '@playwright/test';
import { assertNoProblems, expectNoAxeViolations, login, openRoute, waitForIndexed, watchForProblems } from './helpers.js';

test.describe('insights', () => {
  test.beforeEach(async ({ request }) => {
    await login(request);
    await waitForIndexed(request);
  });

  test('lists every insight the API returns', async ({ page, request }) => {
    const response = await request.get('/api/analytics/insights?from=2000-01-01&to=2100-01-01');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { insights: { id: string; title: string }[] };

    const problems = watchForProblems(page);
    await openRoute(page, '/insights?from=2000-01-01&to=2100-01-01');
    await expect(page.getByRole('heading', { level: 1, name: 'Insights' })).toBeVisible();
    await expect(page).toHaveTitle(/^Insights · AI Cost Analyzer$/);

    await expect(page.getByText('Findings', { exact: true })).toBeVisible();

    // The header answers "did someone run this, and how fresh is it?" in place.
    await expect(page.getByText('Computed live for this range from the index — nothing to run.')).toBeVisible();
    const howItWorks = page.locator('main').getByRole('link', { name: 'How it works' });
    await expect(howItWorks).toHaveAttribute('href', '/how-it-works');
    await expect(page.getByText(/Index up to date as of /)).toBeVisible();

    if (body.insights.length === 0) {
      await expect(page.getByText('No findings for this range')).toBeVisible();
    } else {
      const articles = page.locator('article');
      await expect(articles).toHaveCount(body.insights.length);
      for (const insight of body.insights.slice(0, 3)) {
        await expect(page.getByRole('heading', { level: 3, name: insight.title })).toBeVisible();
      }
      // Every card names its kind, so colour is never the only channel.
      await expect(page.locator('article').first().getByText(/Saving|Waste|Info/).first()).toBeVisible();
    }

    assertNoProblems(problems, '/insights');
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    await openRoute(page, '/insights?from=2000-01-01&to=2100-01-01');
    await expectNoAxeViolations(page, '/insights');
  });
});

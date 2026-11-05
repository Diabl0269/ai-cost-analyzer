/**
 * Compare (SPEC §10.9). Two ids in the URL, the same rows for each session, and a delta column.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { assertNoProblems, expectNoAxeViolations, login, openRoute, waitForIndexed, watchForProblems } from './helpers.js';

async function twoSessionIds(request: APIRequestContext): Promise<[string, string] | null> {
  await login(request);
  const response = await request.get('/api/sessions?from=2000-01-01&to=2100-01-01&limit=2&sort=cost');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { sessions: { id: string }[] };
  const [first, second] = body.sessions;
  return first && second ? [first.id, second.id] : null;
}

test.describe('compare', () => {
  test.beforeEach(async ({ request }) => {
    await login(request);
    await waitForIndexed(request);
  });

  test('asks for two sessions before it shows anything', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, '/compare');
    await expect(page.getByRole('heading', { level: 1, name: 'Compare sessions' })).toBeVisible();
    await expect(page).toHaveTitle(/^Compare · AI Cost Analyzer$/);
    await expect(page.getByText('Choose two sessions')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Session A', exact: true })).toBeVisible();
    assertNoProblems(problems, '/compare');
  });

  test('the typeahead offers sessions and selecting one writes the URL', async ({ page, request }) => {
    const ids = await twoSessionIds(request);
    test.skip(ids === null, 'the fixture root has fewer than two sessions');

    await openRoute(page, '/compare');
    const combo = page.getByRole('combobox', { name: 'Session A', exact: true });
    await combo.click();
    const listbox = page.getByRole('listbox', { name: 'Session A' });
    await expect(listbox).toBeVisible();
    const option = listbox.getByRole('option').first();
    await expect(option).toBeVisible();
    await option.click();
    await expect(page).toHaveURL(/[?&]a=[0-9a-f-]{8,}/);
  });

  test('shows both sessions side by side with a delta column', async ({ page, request }) => {
    const ids = await twoSessionIds(request);
    test.skip(ids === null, 'the fixture root has fewer than two sessions');
    const [a, b] = ids as [string, string];

    const problems = watchForProblems(page);
    await openRoute(page, `/compare?a=${a}&b=${b}`);

    for (const region of ['Headline', 'By token class', 'Where the money went', 'Main, agents and workflows', 'By model', 'Top tools']) {
      await expect(page.getByRole('region', { name: region })).toBeVisible();
    }

    const headline = page.getByRole('table', { name: /Headline metrics/i });
    await expect(headline.getByRole('columnheader', { name: 'A', exact: true })).toBeVisible();
    await expect(headline.getByRole('columnheader', { name: 'B', exact: true })).toBeVisible();
    await expect(headline.getByRole('columnheader', { name: 'B − A', exact: true })).toBeVisible();
    await expect(headline.getByRole('cell', { name: 'Total cost' })).toBeVisible();

    assertNoProblems(problems, '/compare?a&b');
  });

  /**
   * A combobox that fills silently tells a screen-reader user nothing. The count is announced,
   * the arrow keys move `aria-activedescendant`, and the listbox owns options only — the
   * "Searching…" line used to sit inside it as a bare list item.
   */
  test('the typeahead announces how many sessions it found', async ({ page }) => {
    await openRoute(page, '/compare');
    const combo = page.getByRole('combobox', { name: 'Session A', exact: true });
    await combo.click();

    const listbox = page.getByRole('listbox', { name: 'Session A' });
    await expect(listbox.getByRole('option').first()).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /sessions?\./ }).first()).toContainText(
      /\d+ sessions?\. Use the arrow keys/,
    );

    const first = await combo.getAttribute('aria-activedescendant');
    await combo.press('ArrowDown');
    await expect.poll(async () => combo.getAttribute('aria-activedescendant')).not.toBe(first);

    await expectNoAxeViolations(page, '/compare with the typeahead open');
  });

  test('has no serious or critical accessibility violations', async ({ page, request }) => {
    const ids = await twoSessionIds(request);
    await openRoute(page, ids ? `/compare?a=${ids[0]}&b=${ids[1]}` : '/compare');
    await expectNoAxeViolations(page, '/compare');
  });
});

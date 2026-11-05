import { expect, test } from '@playwright/test';
import { openRoute, waitForIndexed } from './helpers.js';

test('a retained indexing error stays prominent after a browser reload', async ({ page, request }) => {
  await waitForIndexed(request);
  await page.route('**/api/status', async (route) => {
    const original = await route.fetch();
    await route.fulfill({ response: original, json: { ...await original.json(), indexing: false, indexError: 'Synthetic index failure: duplicate agent row' } });
  });
  await openRoute(page, '/sessions');
  const alert = page.getByRole('alert').filter({ hasText: 'Index incomplete' });
  await expect(alert).toContainText('Synthetic index failure: duplicate agent row');
  await expect(page.getByText('Index error', { exact: true })).toBeVisible();
  await page.reload();
  await expect(alert).toContainText('Totals cover only the indexed files.');
  await expect(page.getByText('Index error', { exact: true })).toBeVisible();
});

/**
 * The four analytics pages (SPEC §8.4). Each must render its heading, its tables and — where it
 * draws a chart — the same numbers as a table.
 */
import { expect, test, type Page } from '@playwright/test';
import { assertNoProblems, expectNoAxeViolations, login, openRoute, waitForIndexed, watchForProblems } from './helpers.js';

const RANGE = 'from=2000-01-01&to=2100-01-01';

async function rowCount(page: Page, tableName: RegExp): Promise<number> {
  const rows = page.getByRole('table', { name: tableName }).locator('tbody tr');
  return rows.count();
}

/** Waits for the models query to settle either way, then reports whether the chart is there. */
async function modelChart(page: Page) {
  const daily = page.getByRole('region', { name: 'Daily spend by model' });
  const empty = page.getByText('No model billed in this range');
  await expect(daily.or(empty).first()).toBeVisible({ timeout: 20_000 });
  return daily;
}

test.describe('analytics', () => {
  test.beforeEach(async ({ request }) => {
    await login(request);
    await waitForIndexed(request);
  });

  test('tools: table, filter and MCP grouping', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, `/analytics/tools?${RANGE}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeVisible();
    await expect(page).toHaveTitle(/^Tools · AI Cost Analyzer$/);

    await expect(page.getByText('Tool cost', { exact: true })).toBeVisible();
    await expect(page.getByText('Carry share', { exact: true })).toBeVisible();
    // Attributed money always carries the estimate marker.
    await expect(page.getByText('est.').first()).toBeVisible();

    const table = page.getByRole('table', { name: /Tool cost in the selected range/i });
    const before = await rowCount(page, /Tool cost in the selected range/i);
    test.skip(before === 0, 'no tool call in the fixture root');
    await expect(table).toBeVisible();

    await page.getByLabel('Filter').fill('zzz-no-such-tool');
    await expect(page.getByText('No tool matches')).toBeVisible();

    await page.getByLabel('Filter').fill('');
    await expect(page.getByRole('table', { name: /Tool cost in the selected range/i })).toBeVisible();

    await page.getByRole('radio', { name: 'By MCP server' }).click();
    await expect(page.getByRole('columnheader', { name: /Server/ })).toBeVisible();
    const grouped = await rowCount(page, /Tool cost in the selected range/i);
    expect(grouped).toBeLessThanOrEqual(before);

    assertNoProblems(problems, '/analytics/tools');
  });

  test('tools: one spanning group header carries the badge, and the table is one tab stop', async ({ page }) => {
    await openRoute(page, `/analytics/tools?${RANGE}`);
    const table = page.getByRole('table', { name: /Tool cost in the selected range/i });
    await expect(table).toBeVisible();
    const rows = table.locator('tbody tr');
    test.skip((await rows.count()) < 2, 'needs two tool rows');

    // The four attributed money columns sit under one spanning group header that says "est."
    // once; each column header itself is now just its own name, and the exact column
    // (delegated) stays outside the group.
    const group = page.getByRole('columnheader', { name: /Estimated attribution.*est\./ });
    await expect(group).toBeVisible();
    expect(await group.getAttribute('colspan')).toBe('4');
    for (const column of ['Generate', 'Ingest', 'Carry', 'Total']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true }), `${column} header`).toBeVisible();
    }
    await expect(page.getByRole('columnheader', { name: /est\./ })).toHaveCount(2);
    await expect(page.getByRole('columnheader', { name: /^Delegated$/ })).toBeVisible();

    // The rows are a roving tab stop: focusing one and tabbing leaves the table body rather
    // than walking 475 rows (SPEC §9). Header sort buttons are the only other stops.
    await rows.first().focus();
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(rows.nth(1)).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.closest('tbody') !== null)).toBe(false);

    // ↓ still moves down the rows.
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
  });

  test('models: daily chart reads as a table', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, `/analytics/models?${RANGE}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();

    const daily = await modelChart(page);
    test.skip((await daily.count()) === 0, 'no billed model in the fixture root');

    await expect(page.getByRole('table', { name: /Exact cost per model/i })).toBeVisible();
    await daily.getByRole('radio', { name: 'Table' }).click();
    await expect(daily.getByRole('table', { name: 'Daily spend by model' })).toBeVisible();

    assertNoProblems(problems, '/analytics/models');
  });

  test('hooks: hook and harness tables with a totals receipt', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, `/analytics/hooks?${RANGE}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Hooks & harness' })).toBeVisible();
    await expect(page.getByText('Overhead', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Hooks' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Harness attachments' })).toBeVisible();
    assertNoProblems(problems, '/analytics/hooks');
  });

  test('hooks: a hook with no name is named after its event', async ({ page }) => {
    await openRoute(page, `/analytics/hooks?${RANGE}`);
    const table = page.getByRole('table', { name: /Hook runs in the selected range/i });
    await expect(table).toBeVisible();
    // Whatever the fixture holds, the `(unnamed)` placeholder never reaches the screen.
    await expect(page.getByText('(unnamed)')).toHaveCount(0);
  });

  test('attribution: one table per kind of installed thing', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, `/analytics/attribution?${RANGE}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Attribution' })).toBeVisible();
    for (const region of ['Skills', 'Plugins', 'MCP servers', 'Slash commands']) {
      await expect(page.getByRole('region', { name: region })).toBeVisible();
    }
    assertNoProblems(problems, '/analytics/attribution');
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    for (const path of ['/analytics/tools', '/analytics/models', '/analytics/hooks', '/analytics/attribution']) {
      await openRoute(page, `${path}?${RANGE}`);
      await expectNoAxeViolations(page, path);
    }
  });

  test('the models chart table view is accessible too', async ({ page }) => {
    await openRoute(page, `/analytics/models?${RANGE}`);
    const daily = await modelChart(page);
    test.skip((await daily.count()) === 0, 'no billed model in the fixture root');
    await daily.getByRole('radio', { name: 'Table' }).click();
    await expectNoAxeViolations(page, '/analytics/models (table view)');
  });
});

import { expect, test } from '@playwright/test';
import { openRoute, waitForIndexed } from './helpers.js';
const A1 = 'a1111111-1111-4111-8111-111111111111';
const HISTORY = 'from=2000-01-01&to=2100-01-01';

test.beforeEach(async ({ request }) => { await waitForIndexed(request); });

test('history filters survive overview, session detail, tabs and sidebar navigation', async ({ page }) => {
  await openRoute(page, `/?${HISTORY}&provider=claude`);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page).toHaveURL(/from=2000-01-01/);
  await expect(page).toHaveURL(/provider=claude/);
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
  await page.getByRole('table', { name: /Sessions/ }).getByRole('link', { name: 'Rename the utils helper', exact: true }).click();
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
  await expect(page).toHaveURL(/from=2000-01-01/);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL(/from=2000-01-01/);
  await expect(page).toHaveURL(/to=2100-01-01/);
});

test('empty historical ranges have an explicit all-history recovery', async ({ page }) => {
  await openRoute(page, '/?from=2001-01-01&to=2001-01-02');
  await page.getByRole('button', { name: 'Show all history', exact: true }).click();
  await expect(page).toHaveURL(/from=2000-01-01/);
  await expect(page.getByRole('region', { name: 'Spend by model' })).toBeVisible();
});

test('missing token usage shows unavailable instead of a zero-dollar receipt', async ({ page }) => {
  await page.route(`**/api/sessions/${A1}`, async (route) => {
    const original = await route.fetch();
    const data = await original.json();
    data.summary.usageIncomplete = true;
    data.summary.requestCount = 0;
    data.summary.cost.total = 0;
    await route.fulfill({ response: original, json: data });
  });
  await openRoute(page, `/sessions/${A1}`);
  await expect(page.getByText('Token usage unavailable', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Receipt — exact', { exact: true })).toHaveCount(0);
});


test('selecting a project keeps the other folders available in navigation', async ({ page }) => {
  await openRoute(page, `/sessions?${HISTORY}`);
  const projects = page.getByRole('tree', { name: 'Projects' });
  await expect(projects.getByRole('treeitem')).toHaveCount(2);
  await projects.getByRole('treeitem', { name: /feature-x/ }).click();
  await expect(page).toHaveURL(/project=/);
  await expect(projects.getByRole('treeitem')).toHaveCount(2);
  await expect(projects.getByRole('treeitem', { name: /alpha/ }).first()).toHaveAttribute('aria-level', '1');
  await expect(projects.getByRole('treeitem', { name: /feature-x/ })).toHaveAttribute('aria-level', '2');
});

test('Codex-only sessions omit Claude-specific tally and entrypoint controls', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await openRoute(page, `/sessions?${HISTORY}&provider=codex`);
  await expect(page.getByRole('columnheader', { name: /Claude Code’s tally/ })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Entrypoint', exact: true })).toHaveCount(0);
});


test('the implicit session window and CSV match the visible 30-day default', async ({ page }) => {
  const queryRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/sessions' && url.searchParams.has('from') && url.searchParams.has('to');
  });
  await openRoute(page, '/sessions');
  const url = new URL((await queryRequest).url());
  const csvHref = await page.getByRole('link', { name: 'Export CSV', exact: true }).getAttribute('href');
  const csv = new URL(csvHref!, page.url());
  expect(csv.searchParams.get('from')).toBe(url.searchParams.get('from'));
  expect(csv.searchParams.get('to')).toBe(url.searchParams.get('to'));
  const from = new Date(`${url.searchParams.get('from')}T12:00:00`);
  const to = new Date(`${url.searchParams.get('to')}T12:00:00`);
  expect(Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1).toBe(30);
});

test('overview explains missing telemetry before a user opens individual sessions', async ({ page }) => {
  await page.route('**/api/analytics/overview?**', async route => {
    const original = await route.fetch();
    const data = await original.json();
    data.usageCoverage = { unavailableSessions: 2, partialSessions: 1 };
    await route.fulfill({ response: original, json: data });
  });
  await openRoute(page, `/?${HISTORY}&provider=codex`);
  const warning = page.getByRole('alert').filter({ hasText: 'Some token usage is missing' });
  await expect(warning).toContainText('2 sessions without recorded token usage');
  await expect(warning).toContainText('1 session with incomplete token usage');
  await expect(warning.getByRole('link', { name: 'Review sessions' })).toHaveAttribute('href', /provider=codex.*from=2000-01-01/);
});


for (const width of [375, 1280, 1440, 1800]) {
  test(`session Cost stays inside its scroller at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openRoute(page, `/sessions?${HISTORY}`);
    const table = page.getByRole('table', { name: /^Sessions,/ });
    const cost = table.getByRole('columnheader', { name: /^Cost/ });
    await expect(cost).toBeVisible();
    await expect(async () => {
      const column = await cost.boundingBox();
      const scroller = await table.locator('..').boundingBox();
      expect(column).not.toBeNull();
      expect(scroller).not.toBeNull();
      expect(column!.x + column!.width).toBeLessThanOrEqual(scroller!.x + scroller!.width + 1);
    }).toPass();
  });
}

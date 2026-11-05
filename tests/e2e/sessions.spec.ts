/**
 * Sessions ledger (SPEC section 8.4). Asserted against the synthetic fixture root, whose
 * expected numbers live in tests/fixtures/README.md: four visible sessions totalling
 * $0.399105, with session A1 ("Rename the utils helper") the most expensive at $0.184300.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Result } from 'axe-core';
import { assertNoProblems, openRoute, waitForIndexed, watchForProblems } from './helpers.js';

const ALL_TIME = 'from=2000-01-01&to=2100-01-01';
const BLOCKING = new Set(['serious', 'critical']);

async function scan(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking: Result[] = results.violations.filter((violation: Result) => BLOCKING.has(violation.impact ?? ''));
  expect(
    blocking.map((violation) => `${violation.id} (${violation.impact}) x ${violation.nodes.length}`),
    `serious/critical axe violations on ${where}`,
  ).toEqual([]);
}

test.describe('sessions', () => {
  test.beforeEach(async ({ request }) => {
    await waitForIndexed(request);
  });

  test('the rail lists projects with worktrees nested under their parent', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, `/sessions?${ALL_TIME}`);

    const tree = page.getByRole('tree', { name: 'Projects' });
    await expect(tree).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: /alpha/ }).first()).toBeVisible();

    // The worktree is a child of its parent project, not a sibling.
    const worktree = tree.getByRole('treeitem', { name: /feature-x/ });
    await expect(worktree).toHaveAttribute('aria-level', '2');

    // Selecting a project filters the list through the URL.
    await tree.getByRole('treeitem', { name: /feature-x/ }).click();
    await expect(page).toHaveURL(/project=/);
    await expect(page.getByRole('row')).toHaveCount(1 + 1 + 1); // header + one session + totals footer
    assertNoProblems(problems, '/sessions');
  });

  test('the ledger lists every session with its cost and totals', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, `/sessions?${ALL_TIME}&sort=cost`);

    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
    const rows = page.locator('tbody tr[data-row-index]');
    await expect(rows).toHaveCount(4);

    // Sorted by cost: session A1 first, at exactly $0.184300.
    await expect(rows.first()).toContainText('Rename the utils helper');
    await expect(rows.first().locator('[title="$0.184300"]')).toBeVisible();

    // The footer carries the total for the whole match set, not just this page.
    await expect(page.locator('tfoot')).toContainText('4 sessions');
    await expect(page.locator('tfoot [title="$0.399105"]')).toBeVisible();
    assertNoProblems(problems, '/sessions?sort=cost');
  });

  test('the toolbar filters, and the CSV export carries the same query', async ({ page }) => {
    await openRoute(page, `/sessions?${ALL_TIME}`);

    await page.getByLabel('Filter sessions by title or first prompt').fill('triage');
    await expect(page).toHaveURL(/q=triage/);
    const rows = page.locator('tbody tr[data-row-index]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Build failure triage');

    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveAttribute(
      'href',
      /\/api\/export\/sessions\.csv\?.*q=triage/,
    );

    await page.getByRole('switch', { name: 'Has agents' }).click();
    await expect(page).toHaveURL(/hasAgents=true/);
  });

  test('j and Enter move through rows and open a session', async ({ page }) => {
    await openRoute(page, `/sessions?${ALL_TIME}&sort=cost`);
    await page.locator('tbody tr[data-row-index]').first().waitFor();

    await page.keyboard.press('j');
    await expect(page.locator('tbody tr[data-row-index="0"]')).toBeFocused();
    await page.keyboard.press('j');
    await expect(page.locator('tbody tr[data-row-index="1"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}/);
  });

  /**
   * Every numeric column holds exactly one right-aligned figure. Duration used to be stacked
   * under Started with no header of its own, and the subagent count rode along inside Tools
   * ("479 ⚇5"), which broke the right edge of that column on the rows that had one.
   */
  test('each figure has its own column, and an auto title carries no badge', async ({ page }) => {
    // The complete column set needs enough measured space beside the project rail.
    await page.setViewportSize({ width: 1800, height: 900 });
    await openRoute(page, `/sessions?${ALL_TIME}`);
    for (const header of ['Started', 'Duration', 'Prompts', 'Requests', 'Tools', 'Agents', 'Cost']) {
      await expect(page.getByRole('columnheader', { name: new RegExp(`^${header}$`) })).toBeVisible();
    }

    const rows = page.locator('tbody tr[data-row-index]');
    // A1's title came from Claude Code, which is the default: no badge.
    await expect(rows.filter({ hasText: 'Rename the utils helper' })).not.toContainText('auto');
    // A2's title is one the user set, which is worth saying.
    await expect(rows.filter({ hasText: 'Build failure triage' })).toContainText('named');
  });

  /** Below 700px the ledger is two columns and the rest of the row moves under the title. */
  test('the narrow ledger keeps the title and the cost', async ({ page }) => {
    await page.setViewportSize({ width: 680, height: 900 });
    await openRoute(page, `/sessions?${ALL_TIME}`);

    await expect(page.getByRole('columnheader', { name: /^Cost$/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /^Started$/ })).toHaveCount(0);
    await expect(page.locator('tbody tr[data-row-index]').first()).toContainText(/requests?/);
  });

  /**
   * The column used to be headed "Claude Code" with four one-word badges under it and nothing
   * saying what the words meant. The header names the comparison and carries the key.
   */
  test("the tally column explains its four badges", async ({ page }) => {
    await openRoute(page, `/sessions?${ALL_TIME}`);
    await expect(page.getByRole('columnheader', { name: /Claude Code’s tally/ })).toBeVisible();

    const info = page.getByRole('button', { name: 'What the tally badges mean' });
    await info.focus();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('running tally');
    for (const label of ['match', 'earlier', 'resumed', 'hidden', 'mixed']) {
      await expect(tip).toContainText(label);
    }
    await scan(page, '/sessions with the tally key open');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });

  test('axe reports nothing serious in either theme', async ({ page }) => {
    await openRoute(page, `/sessions?${ALL_TIME}`);
    await scan(page, '/sessions (light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await openRoute(page, `/sessions?${ALL_TIME}`);
    await scan(page, '/sessions (dark)');
  });
});

/**
 * Overview (SPEC §8.4). Asserts the regions the page promises, that every chart can be read as a
 * table, and that the daily strip narrows the range — not the numbers themselves, which belong to
 * whatever transcripts the fixture root holds.
 */
import { expect, test, type Page } from '@playwright/test';
import { assertNoProblems, expectNoAxeViolations, login, openRoute, waitForIndexed, watchForProblems } from './helpers.js';

/** Waits for the overview query to settle either way, then reports whether it found spend. */
async function hasData(page: Page): Promise<boolean> {
  const models = page.getByRole('region', { name: 'Spend by model' });
  const empty = page.getByText('Nothing billed in this range');
  await expect(models.or(empty).first()).toBeVisible({ timeout: 20_000 });
  return (await models.count()) > 0;
}

test.describe('overview', () => {
  test.beforeEach(async ({ request }) => {
    await login(request);
    await waitForIndexed(request);
  });

  test('renders every region the page promises', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, '/');

    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page).toHaveTitle(/^Overview · AI Cost Analyzer$/);

    if (!(await hasData(page))) {
      await expect(page.getByText('Nothing billed in this range')).toBeVisible();
      return;
    }

    for (const label of ['Spend', 'Requests', 'Sessions with requests', 'Prompts', 'Cache hit ratio', 'Cost per prompt']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    await expect(page.getByRole('region', { name: 'Daily spend' })).toBeVisible();
    for (const region of ['Spend by model', 'Spend by project', 'Where the money went', 'Most expensive sessions', 'Plan and budget']) {
      await expect(page.getByRole('region', { name: region })).toBeVisible();
    }

    await expect(page.getByRole('table', { name: /Spend by project/i })).toBeVisible();
    await expect(page.getByRole('table', { name: /Most expensive sessions/i })).toBeVisible();

    assertNoProblems(problems, '/');
  });

  test('the estimated split names the baseline and the re-sent history', async ({ page }) => {
    await openRoute(page, '/');
    test.skip(!(await hasData(page)), 'no billed request in the fixture range');

    const split = page.getByRole('region', { name: 'Where the money went' });
    await expect(split.getByText('Baseline context (system prompt, tools, memory)')).toBeVisible();
    await expect(split.getByText('Assistant replies re-sent as history')).toBeVisible();
    // The residual reconciles the split to the exact total; it flips label when the estimate overshoots.
    await expect(split.getByRole('button', { name: /^(Not attributed|Estimation overshoot)$/ })).toBeVisible();
  });

  test('every chart can be read as a table', async ({ page }) => {
    await openRoute(page, '/');
    test.skip(!(await hasData(page)), 'no billed request in the fixture range');

    const models = page.getByRole('region', { name: 'Spend by model' });
    await models.getByRole('radio', { name: 'Table' }).click();
    await expect(models.getByRole('table', { name: /Spend by model/i })).toBeVisible();
    await models.getByRole('radio', { name: 'Chart' }).click();
    await expect(models.getByRole('table', { name: /Spend by model/i })).toHaveCount(0);
  });

  test('a day on the heat strip narrows the range', async ({ page }) => {
    await openRoute(page, '/');
    test.skip(!(await hasData(page)), 'no billed request in the fixture range');

    const strip = page.getByRole('region', { name: 'Daily spend' });
    const day = strip.getByRole('button').first();
    await day.click();
    await expect(page).toHaveURL(/[?&]from=\d{4}-\d{2}-\d{2}&?/);
    await expect(page).toHaveURL(/[?&]to=\d{4}-\d{2}-\d{2}&?/);
  });

  /**
   * `/api/analytics/overview` returns one entry per **non-empty** day, and the strip's cells are
   * `flex: 1` — so a 30-day window with five working days used to draw five cells and read as a
   * month of solid work. Every day in the window has a cell now, and the table view lists the
   * same days one for one.
   */
  test('the daily strip draws every day in the window, empty ones included', async ({ page }) => {
    await openRoute(page, '/');
    test.skip(!(await hasData(page)), 'no billed request in the fixture range');

    const strip = page.getByRole('region', { name: 'Daily spend' });
    const cells = await strip.getByRole('button').count();
    expect(cells, 'a 30-day default window has 30 cells').toBeGreaterThan(7);
    await expect(strip.getByRole('button', { name: /nothing billed/ }).first()).toBeAttached();

    await strip.getByRole('radio', { name: 'Table' }).click();
    const table = strip.getByRole('table', { name: /Spend by day/i });
    await expect(table).toBeVisible();
    // One row per cell, plus the header row.
    await expect(table.getByRole('row')).toHaveCount(cells + 1);
  });

  test('the what-if simulator writes a shareable URL', async ({ page }) => {
    await openRoute(page, '/?whatIf=opus-5%3Esonnet-5');
    await expect(page.getByRole('button', { name: /What-if pricing \(1\)/ })).toBeVisible();
    await expect(page.getByText(/against list prices/)).toBeVisible();
  });

  /**
   * Every bar used to span the full width, because the split inside it is normalised — so six
   * models with wildly different spend drew six identical strips. The bar length is the model's
   * share of spend now, and the widest bar belongs to the model at the top of the list.
   */
  test("each model's bar is as long as its share of spend", async ({ page }) => {
    await openRoute(page, '/');
    test.skip(!(await hasData(page)), 'no billed request in the fixture range');

    const models = page.getByRole('region', { name: 'Spend by model' });
    // By name, so the ModelChip's own glyph `svg` in the same row is not measured.
    const bars = models.getByRole('img', { name: /Token mix/ });
    const count = await bars.count();
    test.skip(count < 2, 'the fixture range billed only one model');

    const widths: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const box = await bars.nth(index).boundingBox();
      widths.push(box?.width ?? 0);
    }
    // Rows are sorted by spend, so widths must not increase down the list, and the top row
    // must be strictly wider than the bottom one.
    for (let index = 1; index < widths.length; index += 1) {
      expect(widths[index] ?? 0).toBeLessThanOrEqual((widths[index - 1] ?? 0) + 1);
    }
    expect(widths[0] ?? 0).toBeGreaterThan(widths[widths.length - 1] ?? 0);
  });

  /**
   * A previous window holding under a tenth of the current value cannot carry a percentage:
   * "up 1,428%" in red reads as a spending alarm when it only means the window before was
   * nearly empty. It is stated once, under the row — six copies of "vs $0.00 prior" inside it
   * said less than one sentence — and the spend KPI uses its slot for a figure that is known.
   */
  test('a near-empty previous window is stated once, not six times', async ({ page }) => {
    // All time compares against the equally long window before it, which billed nothing.
    await openRoute(page, '/?from=2000-01-01&to=2100-01-01');
    test.skip(!(await hasData(page)), 'no billed request in the fixture range');

    await expect(page.getByText(/^No comparable prior period:/)).toBeVisible();
    const kpis = page.locator('.grid-kpis');
    await expect(kpis).not.toContainText('prior');
    // And no four-digit percentage anywhere in the KPI row.
    await expect(kpis).not.toContainText(/\d,\d\d\d%/);
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    await openRoute(page, '/');
    await expectNoAxeViolations(page, '/');
  });
});

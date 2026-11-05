/**
 * Settings (SPEC §8.4). The important one is the pricing round-trip: an edit must survive
 * `PUT /api/pricing` and a reload, and "Reset to defaults" must put it back.
 */
import { expect, test } from '@playwright/test';
import { assertNoProblems, expectNoAxeViolations, login, openRoute, waitForIndexed, watchForProblems } from './helpers.js';

const OPUS_INPUT = 'Input tokens, USD per million for Claude Opus 5';

test.describe('settings', () => {
  test.beforeEach(async ({ request }) => {
    await login(request);
    await waitForIndexed(request);
  });

  test.afterEach(async ({ request }) => {
    // Whatever a test did to the table, the next one starts from the shipped list prices.
    const response = await request.post('/api/pricing/reset', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(response.status()).toBe(200);
  });

  test('renders every section with an in-page contents list', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, '/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page).toHaveTitle(/^Settings · AI Cost Analyzer$/);

    for (const section of ['Pricing', 'Plan', 'Budget', 'Currency', 'Appearance', 'Data']) {
      await expect(page.getByRole('region', { name: section })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: section })).toBeVisible();
    }

    await expect(page.getByRole('table', { name: /Editable model prices/i })).toBeVisible();
    await expect(page.getByText(/last updated/)).toBeVisible();
    assertNoProblems(problems, '/settings');
  });

  test('the pricing editor groups the cache columns and hides the synthetic sentinel', async ({ page }) => {
    await openRoute(page, '/settings');
    const table = page.getByRole('table', { name: /Editable model prices/i });
    await expect(table).toBeVisible();

    // 5m/1h and the two fast prices each sit under one spanning label instead of four cryptic
    // headers, and the units are stated once in the section note.
    await expect(table.getByRole('columnheader', { name: 'Cache write' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Fast mode' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Cache read' })).toBeVisible();
    await expect(page.getByText('USD per million tokens, except characters per token')).toBeVisible();

    // `<synthetic>` is priced at zero by definition; an editable row of zeros is not an offer.
    await expect(page.getByText('(synthetic)')).toHaveCount(0);
    await expect(page.getByLabel(/Match prefixes for \(synthetic\)/)).toHaveCount(0);

    // Save is the primary action and Reset is a button, not a line of text next to it.
    await expect(page.getByRole('button', { name: 'Save pricing' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset to defaults' })).toBeVisible();
  });

  test('a pricing edit round-trips through the API', async ({ page, request }) => {
    await openRoute(page, '/settings');
    const field = page.getByLabel(OPUS_INPUT);
    await expect(field).toBeVisible();
    const original = await field.inputValue();

    const save = page.getByRole('button', { name: 'Save pricing' });
    await expect(save).toBeDisabled();

    await field.fill('7.5');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText('Pricing saved')).toBeVisible();

    const stored = await request.get('/api/pricing');
    expect(stored.status()).toBe(200);
    const config = (await stored.json()) as { models: { key: string; input: number }[] };
    expect(config.models.find((model) => model.key === 'opus-5')?.input).toBe(7.5);

    await page.reload();
    await expect(page.getByLabel(OPUS_INPUT)).toHaveValue('7.5');
    expect(original).not.toBe('7.5');
  });

  test('an invalid price blocks the save', async ({ page }) => {
    await openRoute(page, '/settings');
    await page.getByLabel('Characters per token for Claude Opus 5').fill('0');
    await expect(page.getByText('Fix these before saving')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save pricing' })).toBeDisabled();
  });

  test('resetting the pricing table asks first', async ({ page }) => {
    await openRoute(page, '/settings');
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expectNoAxeViolations(page, '/settings (reset dialog)');
    await dialog.getByRole('button', { name: 'Keep my prices' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('budget and plan write through to the settings API', async ({ page, request }) => {
    await openRoute(page, '/settings');
    await page.getByLabel('Monthly budget').fill('250');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();

    const stored = await request.get('/api/settings');
    expect(stored.status()).toBe(200);
    expect(((await stored.json()) as { monthlyBudgetUsd: number }).monthlyBudgetUsd).toBe(250);

    await page.getByLabel('Monthly budget').fill('');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
  });

  test('rebuilding the index asks first', async ({ page }) => {
    await openRoute(page, '/settings');
    await page.getByRole('button', { name: 'Rebuild from scratch' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    await openRoute(page, '/settings');
    await expectNoAxeViolations(page, '/settings');
  });
});

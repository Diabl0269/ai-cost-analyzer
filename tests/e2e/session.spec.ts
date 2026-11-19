/**
 * Session detail (SPEC section 8.4): receipt, transcript, tools, agents, hooks, timeline.
 * Numbers come from tests/fixtures/README.md — session A1 costs exactly $0.184300
 * (Opus 5 $0.177475 + Haiku 4.5 $0.006825) and session A2 owns the workflow run wf_test1.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Result } from 'axe-core';
import { assertNoProblems, openRoute, waitForIndexed, watchForProblems } from './helpers.js';

const A1 = 'a1111111-1111-4111-8111-111111111111';
const A2 = 'a2222222-2222-4222-8222-222222222222';
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

test.describe('session detail', () => {
  test.beforeEach(async ({ request }) => {
    await waitForIndexed(request);
  });

  test('the summary shows tokens versus cost by type with a cache-hit figure', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}`);
    const strip = page.getByRole('region', { name: 'Tokens versus cost by type' });
    await expect(strip.getByRole('heading', { name: 'Tokens vs cost by type' })).toBeVisible();
    await expect(strip).toContainText(/Cache hit\s*(\d+(\.\d+)?%|unavailable)/);
    await expect(strip.getByRole('listitem')).toHaveCount(4);
    await expect(strip).toContainText(/% of tokens/);
    await scan(page, `/sessions/${A1} tokens strip`);
  });

  test('the summary receipt adds up to the fixture total', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, `/sessions/${A1}`);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rename the utils helper');
    // Exact receipt: the session total, to the last cent of the fixture table.
    await expect(page.locator('[title="$0.184300"]').first()).toBeVisible();
    // Claude Code's own tally agrees for this session.
    await expect(page.locator('[data-tone="match"]').first()).toBeVisible();

    // By-model rows, exact per model.
    await expect(page.getByRole('cell', { name: /Claude Opus 5/ })).toBeVisible();
    await expect(page.locator('[title="$0.177475"]').first()).toBeVisible();
    await expect(page.locator('[title="$0.006825"]').first()).toBeVisible();
    assertNoProblems(problems, `/sessions/${A1}`);
  });

  test('the estimated split names the baseline and the re-sent history', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}`);

    const receipt = page.locator('#main').getByRole('heading', { name: 'What filled the context' }).locator('..').locator('..');
    await expect(receipt.getByText('Baseline context (system prompt, tools, memory)')).toBeVisible();
    await expect(receipt.getByText('Assistant replies re-sent as history')).toBeVisible();
    // The residual reconciles the split to the exact total; it flips label when the estimate overshoots.
    await expect(receipt.getByRole('button', { name: /^(Not attributed|Estimation overshoot)$/ })).toBeVisible();
    await expect(receipt.getByText('Exact session total')).toBeVisible();
  });

  test('every tab renders from the same fetch', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}`);
    for (const [tab, heading] of [
      ['Transcript', /messages/],
      ['Tools', /Tool calls/],
      ['Hooks & harness', /Hooks/],
      ['Timeline', /Idle gaps/],
    ] as const) {
      await page.getByRole('tab', { name: new RegExp(tab.split(' ')[0] ?? tab) }).click();
      await expect(page.locator('main')).toContainText(heading);
    }
  });

  test('the transcript deep-links to a message and expands a tool call', async ({ page }) => {
    const problems = watchForProblems(page);
    await openRoute(page, `/sessions/${A1}/transcript?seq=11`);

    await expect(page.getByText('Jumped to line 11')).toBeVisible();
    // The Edit tool call emitted by request 11 is on screen and opens on click.
    const edit = page.getByRole('button', { name: /Edit/ }).first();
    await edit.click();
    await expect(edit).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Carry result')).toBeVisible();

    assertNoProblems(problems, 'transcript');
  });

  /**
   * "143 of 1,101 lines" read like truncated data. The count is a number of messages; what is
   * missing is either harness plumbing (the switch says how much) or lines not read yet.
   */
  test('the transcript says what is hidden rather than counting lines', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}/transcript`);
    const main = page.locator('#main');
    await expect(main).toContainText(/\d+ messages/);
    await expect(main).toContainText(/harness lines? hidden/);
    await expect(main).not.toContainText(/of \d+ lines$/);
  });

  /** The per-turn cost is already computed, so the toolbar can jump to the turn that cost most. */
  test('the transcript jumps to the priciest turn', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}/transcript`);
    await page.getByRole('button', { name: /Priciest turn/ }).click();
    await expect(page).toHaveURL(/seq=\d+/);
    await expect(page.getByText(/Jumped to line/)).toBeVisible();
  });

  /**
   * The summary used to end on an unlabelled absolute path clipped mid-filename, and one
   * category over half the bill now says so in a sentence under the receipt.
   */
  test('the summary labels the transcript file and names the cost driver', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}`);
    await expect(page.locator('#main')).toContainText('Transcript file');
    await expect(page.getByRole('button', { name: 'Copy the transcript file path' })).toBeVisible();
    // A1 spends 73% of its total on cache writes.
    await expect(page.locator('#main')).toContainText(/Cache writes were \d+% of this session/);
  });

  /**
   * Deliberately not console-watched: toggling the row count within five seconds of a
   * programmatic scroll makes @tanstack/react-virtual reconcile with `flushSync`, which React
   * logs about in development builds. It is their loop, not ours, and it is dev-only - so this
   * check runs on a transcript that was never scrolled programmatically.
   */
  test('harness lines are hidden behind a switch', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}/transcript`);
    const harness = page.getByRole('switch', { name: 'Show harness lines' });
    await expect(harness).toHaveAttribute('aria-checked', 'false');
    await harness.click();
    await expect(harness).toHaveAttribute('aria-checked', 'true');
    // The harness rows carry the attachment subtype that was hidden a moment ago.
    await expect(page.getByText('total_tokens_reminder').first()).toBeVisible();
  });

  test('the agents tab shows the workflow run and opens an agent transcript', async ({ page }) => {
    await openRoute(page, `/sessions/${A2}/agents`);

    // The workflow run is a group row with its journal counts, and its agents sit under it.
    // Scoped to #main: the run also appears in the rail's "in this session" tree.
    await expect(page.locator('#main').getByText('Workflow run test1')).toBeVisible();
    await expect(page.locator('tbody')).toContainText('journal 2/1');
    await expect(page.locator('tbody')).toContainText('1 failed');

    const rows = page.locator('tbody tr[data-row-index]');
    // 1 workflow run + 2 workflow agents + 2 root agents + 1 nested child.
    await expect(rows).toHaveCount(6);

    await page.getByRole('row', { name: /Trace build failure/ }).click();
    await expect(page).toHaveURL(/\/agents\/b1000000000000001/);
    await expect(page.getByRole('link', { name: 'Agents' })).toBeVisible();
  });

  test('the tools tab prices every call and jumps into the transcript', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}/tools`);
    const rows = page.locator('tbody tr[data-row-index]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Bash');

    await page.getByLabel('Filter by tool name').fill('Edit');
    await expect(rows).toHaveCount(1);
    await rows.first().click();
    await expect(page).toHaveURL(/\/transcript\?seq=11/);
  });

  /**
   * A turn opened by a slash command used to head itself `<command-name>/status</command-name>
   * <command-message>…`. The fixture's command is a `local_command` system line, so the compact
   * one-line rendering of a command-only *prompt* is unit-tested in `tests/web/prompt.test.ts`.
   */
  test('a turn header never shows the command markup', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}/transcript`);
    await expect(page.locator('[data-turn]').first()).toBeVisible();
    await expect(page.locator('#main')).not.toContainText('<command-');
    await openRoute(page, `/sessions/${A1}/timeline`);
    await expect(page.locator('#main')).not.toContainText('<command-');
  });

  test('the harness lines a switch reveals are accessible too', async ({ page }) => {
    await openRoute(page, `/sessions/${A1}/transcript`);
    await page.getByLabel('Show harness lines').click();
    await expect(page.locator('[class*="harness"]').first()).toBeVisible();
    await scan(page, '/sessions/:id/transcript with harness lines');
  });

  test('axe reports nothing serious on any tab', async ({ page }) => {
    for (const path of ['summary', 'transcript', 'tools', 'agents', 'hooks', 'timeline']) {
      await openRoute(page, `/sessions/${A1}/${path}`);
      await scan(page, `/sessions/:id/${path}`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await openRoute(page, `/sessions/${A2}/agents`);
    await scan(page, '/sessions/:id/agents (dark)');
  });
});

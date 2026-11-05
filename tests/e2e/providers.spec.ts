import { expect, test } from '@playwright/test';
import { login, openRoute, waitForIndexed, expectNoAxeViolations } from './helpers.js';

const RANGE = 'from=2026-09-01&to=2026-09-30';
const CODEX_ID = 'codex-d1111111-1111-4111-8111-111111111111';

test.describe('mixed providers', () => {
  test.skip(!process.env.CCA_E2E_CODEX_DIR, 'requires the opt-in synthetic Codex fixture root');
  test.beforeEach(async ({ request }) => {
    await login(request);
    await waitForIndexed(request);
  });

  test('filters sessions and exports, keeps the shared project and provider through navigation', async ({ page, request }) => {
    const all = await (await request.get(`/api/sessions?${RANGE}`)).json();
    const claude = await (await request.get(`/api/sessions?${RANGE}&provider=claude`)).json();
    const codex = await (await request.get(`/api/sessions?${RANGE}&provider=codex`)).json();
    expect(codex.sessions.map((session: { id: string }) => session.id)).toContain(CODEX_ID);
    expect(all.total).toBe(claude.total + codex.total);
    const codexSession = codex.sessions.find((session: { id: string }) => session.id === CODEX_ID);
    expect(claude.sessions.some((session: { projectId: string }) => session.projectId === codexSession.projectId)).toBe(true);

    await openRoute(page, `/sessions?${RANGE}`);
    const provider = page.getByRole('combobox', { name: 'Provider', exact: true });
    await expect(provider).toHaveValue('');
    await expect(page.getByRole('link', { name: 'Codex synthetic cache check', exact: true })).toBeVisible();
    await provider.selectOption('claude');
    await expect(page).toHaveURL(/provider=claude/);
    await expect(page.getByRole('link', { name: 'Codex synthetic cache check', exact: true })).toHaveCount(0);
    await provider.selectOption('codex');
    await expect(page.getByRole('link', { name: 'Codex synthetic cache check', exact: true })).toBeVisible();
    const csv = page.getByRole('link', { name: /CSV/ });
    await expect(csv).toHaveAttribute('href', /provider=codex/);
    const exported = await request.get((await csv.getAttribute('href'))!);
    expect(await exported.text()).toContain(CODEX_ID);
    expect(await exported.text()).not.toContain('a1111111-1111-4111-8111-111111111111');

    await page.getByRole('link', { name: 'Codex synthetic cache check', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${CODEX_ID}\\?provider=codex`));
    await expect(page.getByText(/Codex amounts are API-price estimates/).last()).toBeVisible();
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
    await expect(page).toHaveURL(/transcript\?provider=codex/);
    await expect(page.getByText('Codex synthetic result', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /^Tools/ }).click();
    await expect(page.getByRole('cell', { name: 'exec_command', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /^Hooks/ }).click();
    await expect(page.getByText('Attribution unavailable for Codex', { exact: true })).toBeVisible();
  });

  test('scopes global search and keeps the selector accessible on a phone', async ({ page }) => {
    await openRoute(page, `/sessions?${RANGE}&provider=codex`);
    const search = page.getByRole('searchbox', { name: 'Search sessions and transcripts' });
    await search.fill('synthetic');
    await search.press('Enter');
    await expect(page).toHaveURL(/provider=codex/);
    await expect(page.locator('article').filter({ hasText: 'Codex synthetic cache check' })).toBeVisible();
    await expect(page.locator('article')).toHaveCount(1);
    await page.setViewportSize({ width: 375, height: 812 });
    const provider = page.getByRole('combobox', { name: 'Provider', exact: true });
    await expect(provider).toBeVisible();
    await provider.selectOption('');
    await expect(page).not.toHaveURL(/provider=/);
    await expectNoAxeViolations(page, 'mobile provider filter');
  });
});

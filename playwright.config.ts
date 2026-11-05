import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.CCA_E2E_PORT ?? 4171);
const fixtures = fileURLToPath(new URL('./tests/fixtures/projects', import.meta.url));
const codex = process.env.CCA_E2E_CODEX_DIR;
const copilot = process.env.CCA_E2E_COPILOT_DIR;
const home = process.env.CCA_E2E_HOME ?? fileURLToPath(new URL('./.cca-e2e-home', import.meta.url));

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `node dist/server/cli.js --port ${port} --no-open --claude-dir "${fixtures}"${codex ? ` --codex-dir "${codex}"` : ''}${copilot ? ` --copilot-dir "${copilot}"` : ''}`,
    url: `http://127.0.0.1:${port}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { CCA_HOME: home, CCA_ALLOW_UNAUTH_STATUS: '1' },
  },
});

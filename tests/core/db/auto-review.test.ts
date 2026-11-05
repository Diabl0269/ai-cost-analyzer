import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runIndex } from '../../../core/db/indexer.js';
import { createStore } from '../../../core/db/store.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { defaultSettings } from '../../../core/settings.js';

it('retains auto-review usage and unknown-price warnings through indexed statistics and exports', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cca-auto-review-'));
  const sessions = join(home, 'sessions'); mkdirSync(sessions);
  const fixture = readFileSync(resolve('tests/fixtures/codex/sessions/2026/09/07/rollout-2026-09-07-codex-demo.jsonl'), 'utf8');
  writeFileSync(join(sessions, 'rollout-review.jsonl'), fixture.replaceAll('gpt-5.3-codex', 'codex-auto-review'));
  const dbPath = join(home, 'index.sqlite'); const pricing = defaultPricing();
  const ctx = { pricing, settings: { ...defaultSettings(), hideScratchProjects: false }, now: new Date('2026-11-05T12:00:00Z') };
  const range = { from: '2000-01-01', to: '2100-01-01', provider: 'codex' as const };
  try {
    await runIndex({ roots: [sessions], dbPath, pricing });
    const store = createStore(dbPath);
    try {
      const list = await store.listSessions(range, ctx);
      expect(list.sessions[0]?.tokens).toMatchObject({ input: 600, cacheRead: 400, output: 100, thinking: 20 });
      expect(list.sessions[0]?.requestCount).toBe(1);
      expect(list.sessions[0]?.unpriced).toBe(true);
      expect((await store.overview(range, ctx)).unpricedModels).toEqual(['codex-auto-review']);
      const csv = await store.exportSessionsCsv(range, ctx);
      expect(csv).toContain('codex-auto-review'); expect(csv).toContain('unpriced');
    } finally { store.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

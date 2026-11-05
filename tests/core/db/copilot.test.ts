import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runIndex } from '../../../core/db/indexer.js';
import { createStore } from '../../../core/db/store.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { defaultSettings } from '../../../core/settings.js';
import { rangeQuerySchema } from '../../../server/schemas.js';
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })));

it('indexes CLI, app-format events and VS Code chats with scoped search, exports and readable transcript paging', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cca-copilot-db-')); homes.push(home);
  const chats = join(home, 'workspaceStorage/hash/chatSessions'); mkdirSync(chats, { recursive: true });
  copyFileSync(resolve('tests/fixtures/copilot-vscode/snapshot.json'), join(chats, 'ide.json'));
  const roots = [resolve('tests/fixtures/projects'), resolve('tests/fixtures/codex'), resolve('tests/fixtures/copilot'), join(home, 'workspaceStorage')];
  const dbPath = join(home, 'index.sqlite'); const pricing = defaultPricing();
  const ctx = { pricing, settings: { ...defaultSettings(), hideScratchProjects: false }, now: new Date('2026-11-05T12:00:00Z') };
  const range = { from: '2000-01-01', to: '2100-01-01', provider: 'copilot' as const };
  await runIndex({ roots, dbPath, pricing });
  const store = createStore(dbPath);
  try {
    expect(rangeQuerySchema.parse({ provider: 'copilot' }).provider).toBe('copilot');
    const list = await store.listSessions(range, ctx);
    expect(list.sessions.map(session => session.provider)).toEqual(['copilot', 'copilot']);
    const cli = list.sessions.find(session => session.id === 'copilot-synthetic-cli')!;
    expect(cli.tokens).toMatchObject({ input: 60, cacheRead: 30, cache5m: 10, output: 20 });
    expect(cli.requestCount).toBe(0); // Aggregate usage is not an observed API call.
    expect((await store.overview(range, ctx)).totals.requests).toBe(0);
    expect((await store.modelsAnalytics(range, ctx)).models[0]?.requests).toBe(0);
    expect((await store.getSession(cli.id, ctx))?.requests[0]?.usageGranularity).toBe('session');
    expect(cli.unpriced).toBe(true); // GPT cache writes have no published write tariff.
    const ide = list.sessions.find(session => session.id === 'copilot-vscode-synthetic-ide')!;
    expect(ide.usageIncomplete).toBe(true); expect(ide.requestCount).toBe(0);
    expect(ide.models).toContain('copilot/claude-sonnet-4.6');
    expect((await store.overview(range, ctx)).usageCoverage).toEqual({ unavailableSessions: 1, partialSessions: 0 });
    const transcript = await store.getTranscript(ide.id, null, 0, 100, ctx);
    expect(transcript?.messages.flatMap(message => message.blocks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Explain this synthetic project' }),
      expect.objectContaining({ type: 'tool_use', name: 'run_in_terminal' }),
    ]));
    expect((await store.search({ ...range, scope: 'everything', q: 'synthetic' }, ctx)).totalSessions).toBe(2);
    const csv = await store.exportSessionsCsv(range, ctx);
    expect(csv).toContain('copilot-synthetic-cli'); expect(csv).toContain('copilot-vscode-synthetic-ide');
    expect(csv).toContain('unavailable'); expect(csv).not.toContain('codex-d1111111');
    // Reconstructed journal messages remain readable after re-indexing a changed snapshot.
    writeFileSync(join(chats, 'journal.jsonl'), JSON.stringify({ kind: 0, v: { sessionId: 'journal-paging', creationDate: 1804204800000, workingDirectory: '/workspace/example', requests: [{ modelId: 'copilot/gpt-5', message: { text: 'Journal synthetic prompt' }, response: [{ value: 'Journal synthetic result' }] }] } }) + '\n');
    await runIndex({ roots, dbPath, pricing });
    const journal = await store.getTranscript('copilot-vscode-journal-paging', null, 0, 1, ctx);
    expect(journal?.messages[0]?.blocks).toContainEqual({ type: 'text', text: 'Journal synthetic prompt' });
    expect(journal?.nextFromSeq).toBe(1);
    const next = await store.getTranscript('copilot-vscode-journal-paging', null, 1, 1, ctx);
    expect(next?.messages[0]?.blocks).toContainEqual({ type: 'text', text: 'Journal synthetic result' });
    expect((await store.listSessions({ ...range, project: '/workspace/example' }, ctx)).total).toBe(2);
  } finally { store.close(); }
});

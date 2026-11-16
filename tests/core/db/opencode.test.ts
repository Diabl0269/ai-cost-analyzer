import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexChangedFiles, runIndex } from '../../../core/db/indexer.js';
import { createStore } from '../../../core/db/store.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { defaultSettings } from '../../../core/settings.js';
import { rangeQuerySchema } from '../../../server/schemas.js';
import { T0, createLegacyDb } from '../../helpers/opencode-db.js';
import { DatabaseSync } from 'node:sqlite';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

it('indexes OpenCode sessions with provider scoping, subagents, transcripts and incremental updates', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cca-opencode-db-')); homes.push(home);
  const data = join(home, 'opencode-data');
  const dbFile = createLegacyDb(data);
  const dbPath = join(home, 'index.sqlite');
  const pricing = defaultPricing();
  const ctx = { pricing, settings: { ...defaultSettings(), hideScratchProjects: false }, now: new Date('2026-11-05T12:00:00Z') };
  const range = { from: '2000-01-01', to: '2100-01-01', provider: 'opencode' as const };
  await runIndex({ roots: [data], dbPath, pricing });
  const store = createStore(dbPath);
  try {
    expect(rangeQuerySchema.parse({ provider: 'opencode' }).provider).toBe('opencode');
    const list = await store.listSessions(range, ctx);
    expect(list.sessions).toHaveLength(1);
    const session = list.sessions[0]!;
    expect(session).toMatchObject({ id: 'opencode-ses_root', provider: 'opencode', title: 'Fix the synthetic parser', agentCount: 1, usageIncomplete: true });
    expect(session.tokens).toMatchObject({ input: 110, output: 55, cacheRead: 500 });
    expect(session.cost.total).toBeGreaterThan(0);
    expect(session.models).toContain('claude-sonnet-4.5');
    expect((await store.listSessions({ ...range, provider: 'claude' }, ctx)).sessions).toHaveLength(0);
    const transcript = await store.getTranscript(session.id, null, 0, 100, ctx);
    expect(transcript?.messages.flatMap((message) => message.blocks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Please fix the synthetic parser' }),
      expect.objectContaining({ type: 'tool_use', name: 'read' }),
    ]));
    const child = await store.getTranscript(session.id, 'ses_child', 0, 100, ctx);
    expect(child?.messages.flatMap((message) => message.blocks)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Explored' })]));
    expect((await store.search({ ...range, scope: 'everything', q: 'parser' }, ctx)).totalSessions).toBe(1);
    expect(await store.exportSessionsCsv(range, ctx)).toContain('opencode-ses_root');

    // A change inside the shared database is attributed to the session it touched, via the WAL path too.
    const db = new DatabaseSync(dbFile);
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m9', 'ses_root', T0 + 40_000, T0 + 40_000, JSON.stringify({ role: 'assistant', time: { created: T0 + 40_000 }, modelID: 'claude-sonnet-4.5', tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('m9_p', 'm9', 'ses_root', T0 + 40_000, T0 + 40_000, JSON.stringify({ type: 'text', text: 'late reply' }));
    db.close();
    const result = await indexChangedFiles([`${dbFile}-wal`], { roots: [data], dbPath, pricing });
    expect(result.changedSessionIds).toEqual(['opencode-ses_root']);
    expect((await store.listSessions(range, ctx)).sessions[0]!.tokens).toMatchObject({ input: 111, output: 57 });
  } finally { store.close?.(); }
});

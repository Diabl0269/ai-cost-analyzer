import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexChangedFiles, runIndex } from '../../../core/db/indexer.js';
import { createStore } from '../../../core/db/store.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { defaultSettings } from '../../../core/settings.js';
import { rangeQuerySchema } from '../../../server/schemas.js';
import {
  CHILD_CONV_ID,
  ROOT_CONV_ID,
  createSyntheticAntigravityDir,
  createSyntheticGeminiCliDir,
} from '../../helpers/gemini-fixture.js';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

it('indexes Antigravity and Gemini CLI sessions, merges shared folders, serves transcripts and updates incrementally', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cca-gemini-db-'));
  homes.push(home);
  const agy = createSyntheticAntigravityDir(home);
  const cli = createSyntheticGeminiCliDir(home);
  const dbPath = join(home, 'index.sqlite');
  const pricing = defaultPricing();
  const ctx = {
    pricing,
    settings: { ...defaultSettings(), hideScratchProjects: false },
    now: new Date('2026-09-20T12:00:00Z'),
  };
  const range = { from: '2026-09-01', to: '2026-09-30', provider: 'gemini' as const };

  await runIndex({ roots: [agy.brainDir, cli.tmpDir], dbPath, pricing });
  const store = createStore(dbPath);
  try {
    expect(rangeQuerySchema.parse({ provider: 'gemini' }).provider).toBe('gemini');
    const list = await store.listSessions(range, ctx);
    expect(list.sessions.map((s) => s.id).sort()).toEqual([
      `antigravity-${ROOT_CONV_ID}`,
      'gemini-cli-legacy-02',
      'gemini-cli-sess-01',
    ]);

    const antigravitySession = list.sessions.find((s) => s.id === `antigravity-${ROOT_CONV_ID}`)!;
    const cliSession = list.sessions.find((s) => s.id === 'gemini-cli-sess-01')!;
    const legacySession = list.sessions.find((s) => s.id === 'gemini-cli-legacy-02')!;

    // Antigravity and Gemini CLI sessions in `/workspace/synthetic-app` share one projectId.
    expect(antigravitySession.projectId).toBe(cliSession.projectId);
    expect(antigravitySession.agentCount).toBe(1);
    expect(antigravitySession.costMain).toBeGreaterThan(0);
    expect(antigravitySession.costAgents).toBeGreaterThan(0);
    expect(antigravitySession.unpriced).toBe(false);

    // Unbilled legacy Gemini CLI session shows incomplete usage rather than $0recorded.
    expect(legacySession.usageIncomplete).toBe(true);
    expect(legacySession.requestCount).toBe(0);

    // Transcript paging works for both main and subagent transcripts.
    const mainTranscript = await store.getTranscript(antigravitySession.id, null, 0, 100, ctx);
    expect(mainTranscript?.messages.flatMap((m) => m.blocks)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Audit the synthetic widget cache' }),
        expect.objectContaining({ type: 'tool_use', name: 'invoke_subagent' }),
      ]),
    );
    const childTranscript = await store.getTranscript(antigravitySession.id, CHILD_CONV_ID, 0, 100, ctx);
    expect(childTranscript?.messages.flatMap((m) => m.blocks)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'All widget imports are valid.' })]),
    );

    // Search and CSV export honor `provider: 'gemini'`.
    expect((await store.search({ ...range, scope: 'everything', q: 'widget cache' }, ctx)).totalSessions).toBe(1);
    const csv = await store.exportSessionsCsv(range, ctx);
    expect(csv).toContain(`antigravity-${ROOT_CONV_ID}`);
    expect(csv).toContain('gemini-cli-legacy-02');

    // Incremental watcher update via `transcript.jsonl` refreshes `transcript_full.jsonl`,
    // including consecutive empty-content error steps without colliding on api_errors.seq.
    const extraStep =
      [
        {
          step_index: 6,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'ERROR',
          created_at: '2026-09-12T10:03:50Z',
          error: 'transient quota error',
        },
        {
          step_index: 7,
          source: 'SYSTEM',
          type: 'ERROR_MESSAGE',
          status: 'ERROR',
          created_at: '2026-09-12T10:03:51Z',
          error_code: 429,
          error: 'rate limited',
        },
        {
          step_index: 8,
          source: 'SYSTEM',
          type: 'ERROR_MESSAGE',
          status: 'ERROR',
          created_at: '2026-09-12T10:03:52Z',
          error_code: 503,
        },
        {
          step_index: 9,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-09-12T10:04:00Z',
          model: 'gemini-4-carbon-medium',
          input_tokens: 500,
          cache_read_tokens: 12_000,
          output_tokens: 50,
          content: 'Follow-up verification.',
        },
      ]
        .map((s) => JSON.stringify(s))
        .join('\n') + '\n';
    appendFileSync(agy.rootTranscript, extraStep);
    appendFileSync(agy.rootCompactTranscript, extraStep);
    const changed = await indexChangedFiles([agy.rootCompactTranscript], {
      roots: [agy.brainDir, cli.tmpDir],
      dbPath,
      pricing,
    });
    expect(changed.changedSessionIds).toEqual([`antigravity-${ROOT_CONV_ID}`]);
    const refreshed = (await store.listSessions(range, ctx)).sessions.find(
      (s) => s.id === `antigravity-${ROOT_CONV_ID}`,
    )!;
    expect(refreshed.requestCount).toBe(4);
    expect(refreshed.apiErrorCount).toBe(3);
  } finally {
    store.close?.();
  }
});

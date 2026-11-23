import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiScan, isGeminiRoot } from '../../../core/gemini/discover.js';
import { antigravityPrompt } from '../../../core/gemini/prompts.js';
import { antigravityUsage, geminiCliUsage, readGeminiSessionLines } from '../../../core/gemini/transcript.js';
import { parseSession } from '../../../core/parse/session.js';
import {
  CHILD_CONV_ID,
  ROOT_CONV_ID,
  createSyntheticAntigravityDir,
  createSyntheticGeminiCliDir,
} from '../../helpers/gemini-fixture.js';

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cca-gemini-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function discover(root: string) {
  const scan = new GeminiScan();
  await scan.scan(root);
  return { sessions: scan.finish(), warnings: scan.warnings };
}

describe('Antigravity prompt normalization', () => {
  it('unwraps <USER_REQUEST> and strips trailing harness metadata while preserving quoted tags in prose', () => {
    const raw =
      '<USER_REQUEST>\nFix <USER_REQUEST> parsing in docs\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>';
    const parsed = antigravityPrompt(raw);
    expect(parsed.text).toBe('Fix <USER_REQUEST> parsing in docs');
    expect(parsed.isMeta).toBe(false);
    expect(parsed.harnessChars).toBeGreaterThan(0);

    const wakeup = antigravityPrompt('<SYSTEM_MESSAGE>\nTask finished\n</SYSTEM_MESSAGE>');
    expect(wakeup.isMeta).toBe(true);
    expect(wakeup.text).toBe('');

    const plain = antigravityPrompt('Explain how <USER_REQUEST> tags work');
    expect(plain).toEqual({ text: 'Explain how <USER_REQUEST> tags work', harnessChars: 0, isMeta: false });
  });
});

describe('Gemini & Antigravity discovery and parsing', () => {
  it('normalizes Antigravity and Gemini CLI token counters accurately', () => {
    expect(antigravityUsage({ input_tokens: 6000, cache_read_tokens: 10000, output_tokens: 450 })).toEqual({
      input_tokens: 6000,
      output_tokens: 450,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 0 },
    });

    // Gemini CLI input (`promptTokenCount`) includes `cached`, while `thoughts` is separate from `output`.
    expect(
      geminiCliUsage({ input: 5000, cached: 2000, tool: 500, output: 100, thoughts: 300, total: 5900 }),
    ).toEqual({
      input_tokens: 3500,
      output_tokens: 400,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 300 },
    });
  });

  it('discovers Antigravity brain conversations, folds subagents, and links invoke_subagent calls', async () => {
    const base = temp();
    const { appDir, brainDir, rootTranscript } = createSyntheticAntigravityDir(base);
    expect(await isGeminiRoot(appDir)).toBe(true);
    expect(await isGeminiRoot(brainDir)).toBe(true);

    const { sessions, warnings } = await discover(brainDir);
    expect(warnings).toEqual([]);
    expect(sessions.map((s) => s.sessionId)).toEqual([`antigravity-${ROOT_CONV_ID}`]);
    const [root] = sessions;
    expect(root).toMatchObject({
      provider: 'gemini',
      projectDirPath: '/workspace/synthetic-app',
    });
    expect(root!.agentFiles).toHaveLength(1);
    expect(root!.agentFiles[0]).toMatchObject({ kind: 'subagent', agentId: CHILD_CONV_ID });

    const parsed = await parseSession(root!);
    expect(parsed.main.meta).toMatchObject({
      cwd: '/workspace/synthetic-app',
      entrypoint: 'antigravity-cli',
      effort: 'medium',
      firstPrompt: 'Audit the synthetic widget cache',
    });
    expect(parsed.main.facts?.aiTitle).toBe('Synthetic Antigravity Feature');
    // System wakeup message is marked isMeta and excluded from human promptCount.
    expect(parsed.main.promptCount).toBe(1);
    expect(parsed.main.requests).toHaveLength(2);
    expect(parsed.main.requests[0]).toMatchObject({
      model: 'gemini-4-carbon-medium',
      usage: { input: 10_000, cacheRead: 0, output: 500 },
      contextTokens: 10_000,
    });
    expect(parsed.main.requests[1]).toMatchObject({
      model: 'gemini-4-carbon-medium',
      usage: { input: 2_000, cacheRead: 10_000, output: 300 },
      contextTokens: 12_000,
    });
    expect(parsed.main.toolCalls).toMatchObject([
      { name: 'read_file', isError: false },
      { name: 'invoke_subagent', childAgentId: CHILD_CONV_ID, childDescription: 'Codebase Researcher', childModel: 'gemini-4-hydrogen-low' },
    ]);
    expect(parsed.agentMeta[CHILD_CONV_ID]).toMatchObject({
      agentType: 'research',
      description: 'Codebase Researcher',
      model: 'gemini-4-hydrogen-low',
    });
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]!.requests[0]).toMatchObject({
      model: 'gemini-4-hydrogen-low',
      usage: { input: 4_000, cacheRead: 1_000, output: 200 },
    });

    // Falls back cleanly to compact `transcript.jsonl` when `transcript_full.jsonl` is absent.
    unlinkSync(rootTranscript);
    const fallback = (await discover(brainDir)).sessions[0]!;
    expect(fallback.mainFile.path.endsWith('transcript.jsonl')).toBe(true);
    const lines = await readGeminiSessionLines(fallback.mainFile.path);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('discovers and parses Gemini CLI .jsonl and legacy .json sessions, preserving incomplete telemetry', async () => {
    const base = temp();
    const { tmpDir } = createSyntheticGeminiCliDir(base);
    expect(await isGeminiRoot(tmpDir)).toBe(true);

    const { sessions } = await discover(tmpDir);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['gemini-cli-legacy-02', 'gemini-cli-sess-01']);

    const modern = await parseSession(sessions.find((s) => s.sessionId === 'gemini-cli-sess-01')!);
    expect(modern.main.meta).toMatchObject({
      cwd: '/workspace/synthetic-app',
      entrypoint: 'gemini-cli',
      sessionKind: 'main',
    });
    expect(modern.main.facts?.aiTitle).toBe('Synthetic Gemini CLI session');
    expect(modern.main.requests).toHaveLength(1);
    expect(modern.main.requests[0]).toMatchObject({
      model: 'gemini-3.5-flash',
      usage: { input: 3_500, cacheRead: 2_000, output: 400, thinking: 300 },
      contextTokens: 5_500,
    });
    expect(modern.main.toolCalls).toMatchObject([{ name: 'run_shell_command', isError: false }]);

    const legacy = await parseSession(sessions.find((s) => s.sessionId === 'gemini-cli-legacy-02')!);
    expect(legacy.main.meta.usageIncomplete).toBe(true);
    expect(legacy.main.meta.recordedModels).toEqual(['gemini-2.5-pro']);
    expect(legacy.main.requests).toHaveLength(0);
    expect(sessions.find((s) => s.sessionId === 'gemini-cli-legacy-02')!.projectDirPath).toBe('/workspace/mapped-app');
  });
});

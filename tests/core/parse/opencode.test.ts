import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeScan, isOpenCodeRoot } from '../../../core/opencode/discover.js';
import { openCodeUsage, parseOpenCodeTranscript, readOpenCodeSessionLines } from '../../../core/opencode/transcript.js';
import { splitOpenCodePath } from '../../../core/opencode/db.js';
import { parseSession } from '../../../core/parse/session.js';
import { createLegacyDb, createV2Db } from '../../helpers/opencode-db.js';

const dirs: string[] = [];
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'cca-opencode-')); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function discover(root: string) {
  const scan = new OpenCodeScan();
  await scan.scan(root);
  return { sessions: scan.finish(), warnings: scan.warnings };
}

describe('OpenCode discovery', () => {
  it('recognizes a data directory or database file and nothing else', async () => {
    const dir = temp();
    expect(await isOpenCodeRoot(dir)).toBe(false);
    const file = createLegacyDb(dir);
    expect(await isOpenCodeRoot(dir)).toBe(true);
    expect(await isOpenCodeRoot(file)).toBe(true);
    expect(await isOpenCodeRoot(join(dir, 'missing'))).toBe(false);
  });

  it('folds child sessions into their parent as subagents', async () => {
    const root = temp();
    createLegacyDb(root);
    const { sessions } = await discover(root);
    expect(sessions.map((session) => session.sessionId)).toEqual(['opencode-ses_root']);
    const [parent] = sessions;
    expect(parent).toMatchObject({ provider: 'opencode', projectDirPath: '/workspace/example', projectDirName: `opencode-project-${Buffer.from('/workspace/example').toString('base64url')}` });
    expect(parent!.agentFiles).toHaveLength(1);
    expect(parent!.agentFiles[0]).toMatchObject({ kind: 'subagent', agentId: 'ses_child' });
    expect(splitOpenCodePath(parent!.mainFile.path)?.sessionId).toBe('ses_root');
  });

  it('discovers the newer session_v2 layout', async () => {
    const root = temp();
    createV2Db(root);
    expect((await discover(root)).sessions.map((session) => session.sessionId)).toEqual(['opencode-ses_v2']);
  });
});

describe('OpenCode transcripts', () => {
  it('maps tokens: input excludes cache and reasoning is part of output', () => {
    expect(openCodeUsage({ input: 4, output: 6, reasoning: 142, cacheRead: 5, cacheWrite: 7 })).toEqual({
      input_tokens: 4, output_tokens: 148, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, output_tokens_details: { thinking_tokens: 142 },
    });
  });

  it('parses a legacy session with tools, titles and unbilled output', async () => {
    const root = temp();
    createLegacyDb(root);
    const [session] = (await discover(root)).sessions;
    const parsed = await parseSession(session!);
    const main = parsed.main;
    expect(main.requests).toHaveLength(1);
    expect(main.requests[0]).toMatchObject({ model: 'claude-sonnet-4.5', usage: { input: 100, output: 50, cacheRead: 500 } });
    expect(main.toolCalls).toMatchObject([{ name: 'read', toolUseId: 'call_1', isError: false }]);
    expect(main.promptCount).toBe(2);
    expect(main.meta).toMatchObject({ cwd: '/workspace/example', entrypoint: 'opencode', usageIncomplete: true });
    expect(main.facts?.aiTitle).toBe('Fix the synthetic parser');
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]!.requests).toHaveLength(1);
    expect(parsed.agents[0]!.facts).toBeUndefined();
  });

  it('parses the session_v2 layout, marking failed tool calls and ignoring error-only turns', async () => {
    const root = temp();
    createV2Db(root);
    const [session] = (await discover(root)).sessions;
    const transcript = await parseOpenCodeTranscript(session!.mainFile);
    expect(transcript.requests).toHaveLength(1);
    expect(transcript.requests[0]).toMatchObject({ model: 'claude-opus-4-5', effort: 'high', usage: { input: 4, output: 290, cacheRead: 5348 } });
    expect(transcript.toolCalls.map((call) => [call.name, call.isError])).toEqual([['shell', false], ['shell', true]]);
    expect(transcript.meta.usageIncomplete).toBeUndefined();
    expect(transcript.meta.version).toBe('2.0.0');
    const lines = await readOpenCodeSessionLines(session!.mainFile.path);
    expect(lines.length).toBeGreaterThan(transcript.messages.length - 1);
    expect(JSON.stringify(lines)).not.toContain('idle');
  });
});

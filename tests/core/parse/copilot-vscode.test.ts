import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, copyFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import { parseVscodeCopilotTranscript, readVscodeCopilotLines, replayVscodeCopilotJournal, VscodeCopilotScan } from '../../../core/copilot/vscode.js';
import type { DiscoveredFile } from '../../../core/types.js';
const fixture = path.resolve('tests/fixtures/copilot-vscode/snapshot.json');
describe('VS Code Copilot storage', () => {
  it('preserves prompts, titles, thinking and tools without treating context counters as billed usage', async () => {
    const info = await stat(fixture);
    const file: DiscoveredFile = { provider: 'copilot', path: fixture, size: info.size, mtimeMs: info.mtimeMs, kind: 'main', projectDirName: 'synthetic', sessionId: 'copilot-vscode-synthetic-ide' };
    const parsed = await parseVscodeCopilotTranscript(file);
    expect(parsed.facts?.customTitle).toBe('Synthetic IDE chat');
    expect(parsed.meta.cwd).toBe('/synthetic/project');
    expect(parsed.meta.usageIncomplete).toBe(true);
    expect(parsed.requests).toEqual([]);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.requestSeq).toBe(-1);
    const lines = await readVscodeCopilotLines(fixture);
    expect(JSON.stringify(lines)).toContain('Explain this synthetic project');
    expect(lines.some(line => JSON.stringify(line).includes('Check the structure.'))).toBe(true);
    expect(JSON.stringify(lines)).toContain('ls src');
    expect(JSON.stringify(lines)).toContain('copilot/claude-sonnet-4.6');
  });
  it('replays set, nested paths, push/truncate and delete without duplicating earlier response states', () => {
    const journal = [
      { kind: 0, v: { requests: [{ message: 'old', response: [] }], obsolete: true } },
      { kind: 1, k: ['requests', 0, 'message'], v: 'new' },
      { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'partial' }] },
      { kind: 2, k: ['requests', 0, 'response'], i: 0, v: [{ value: 'complete' }] },
      { kind: 3, k: ['obsolete'] },
    ].map((value) => JSON.stringify(value)).join('\n');
    expect(replayVscodeCopilotJournal(journal)).toEqual({ requests: [{ message: 'new', response: [{ value: 'complete' }] }] });
    expect(() => replayVscodeCopilotJournal('{"kind":1,"k":["requests"],"v":[]}')).toThrow();
    expect(() => replayVscodeCopilotJournal('{"kind":0,"v":{"requests":[]}}\n{"kind":1,"k":["__proto__","polluted"],"v":true}')).toThrow();
  });
  it('discovers workspace and empty-window sessions, preferring journals and skipping unrelated providers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cca-vscode-'));
    try {
      const chats = path.join(root, 'workspaceStorage', 'hash', 'chatSessions');
      const empty = path.join(root, 'globalStorage', 'emptyWindowChatSessions');
      await mkdir(chats, { recursive: true }); await mkdir(empty, { recursive: true });
      await copyFile(fixture, path.join(chats, 'a.json'));
      await writeFile(path.join(chats, 'other.json'), JSON.stringify({ sessionId: 'other', requests: [{ agent: { extensionId: { value: 'other.extension' } } }] }));
      const state = { sessionId: 'journal', requests: [{ message: 'Synthetic journal prompt', modelId: 'copilot/gpt-4.1', response: [{ value: 'Synthetic response' }] }] };
      await writeFile(path.join(empty, 'b.jsonl'), JSON.stringify({ kind: 0, v: state }) + '\n');
      await writeFile(path.join(empty, 'b.json'), JSON.stringify({ ...state, sessionId: 'stale' }));
      const scan = new VscodeCopilotScan(); await scan.scan(root);
      expect(scan.warnings).toEqual([]);
      expect(scan.finish().map((session) => session.sessionId).sort()).toEqual(['copilot-vscode-journal', 'copilot-vscode-synthetic-ide']);
      expect(await readVscodeCopilotLines(path.join(empty, 'b.jsonl'))).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

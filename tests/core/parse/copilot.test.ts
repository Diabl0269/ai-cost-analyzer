import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CopilotScan, isCopilotRoot } from '../../../core/copilot/discover.js';
import { normalizeCopilotLine } from '../../../core/copilot/normalize.js';
import { copilotUsage, parseCopilotTranscript } from '../../../core/copilot/transcript.js';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
let eventId = 0;
const event = (type: string, data: unknown, id = `event-${eventId++}`) => ({ id, type, timestamp: '2026-01-01T00:00:00.000Z', data });
const usage = (inputTokens: number, cacheReadTokens: number, outputTokens: number, cacheWriteTokens = 0) => ({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens: 2 });
const metric = (u: unknown) => ({ requests: { count: 7, cost: 70 }, usage: u });
async function root() { const p = await mkdtemp(path.join(tmpdir(), 'cca-copilot-')); cleanup.push(p); return p; }
async function sessionFile(root: string, id: string, rows: unknown[], cwd = '/workspace/example') {
  const p = path.join(root, 'session-state', id, 'events.jsonl');
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, [event('session.start', { sessionId: id, context: { cwd, branch: 'main' }, copilotVersion: '1.0', producer: 'copilot', selectedModel: 'gpt-5' }), ...rows].map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  return p;
}
async function parsed(rows: unknown[]) {
  const r = await root(); await sessionFile(r, 'synthetic', rows);
  const scan = new CopilotScan(); await scan.scan(r);
  expect(scan.warnings).toEqual([]);
  return parseCopilotTranscript(scan.finish()[0]!.mainFile);
}
const prompt = (content: string) => event('user.message', { content });
const answer = (content: string, extra = {}) => event('assistant.message', { messageId: `msg-${eventId}`, content, ...extra });

describe('Copilot CLI session-state adapter', () => {
  it('discovers only session-state events, preserves exact cwd grouping, and deduplicates roots', async () => {
    const r = await root();
    await sessionFile(r, 'one', [], '/workspace/foo-bar');
    await sessionFile(r, 'two', [], '/workspace/foo/bar');
    await writeFile(path.join(r, 'auth.json'), '{"token":"synthetic"}');
    await writeFile(path.join(r, 'arbitrary.jsonl'), JSON.stringify(event('session.start', { sessionId: 'ignored' })));
    await mkdir(path.join(r, 'unrelated/session'), { recursive: true });
    await writeFile(path.join(r, 'unrelated/session/events.jsonl'), JSON.stringify(event('session.start', { sessionId: 'ignored' })));
    await symlink(path.join(r, 'auth.json'), path.join(r, 'session-state/one/secrets.jsonl'));
    const scan = new CopilotScan();
    await scan.scan(r); await scan.scan(path.join(r, 'session-state')); await scan.scan(path.join(r, 'session-state/one'));
    expect(scan.finish().map((s) => s.sessionId)).toEqual(['copilot-one', 'copilot-two']);
    expect(new Set(scan.finish().map((s) => s.projectDirName)).size).toBe(2);
    expect(scan.finish()[0]).toMatchObject({ provider: 'copilot', projectDirPath: '/workspace/foo-bar' });
    expect(await isCopilotRoot(r)).toBe(true);
    expect(await isCopilotRoot(path.join(r, 'session-state/one'))).toBe(true);
    expect(await isCopilotRoot(path.join(r, 'unrelated'))).toBe(false);
    const single = new CopilotScan(); await single.scan(path.join(r, 'session-state/one'));
    expect(single.finish()).toHaveLength(1);
  });

  it('reads the committed synthetic fixture', async () => {
    const scan = new CopilotScan(); await scan.scan(path.resolve('tests/fixtures/copilot'));
    expect(scan.finish()).toHaveLength(1);
    const t = await parseCopilotTranscript(scan.finish()[0]!.mainFile);
    expect(t.requests[0]).toMatchObject({ model: 'gpt-5', contextTokens: 0, usage: { input: 60, cacheRead: 30, cache5m: 10, output: 20 } });
  });

  it('reconciles cumulative checkpoints and shutdowns across resumes without doubling tokens', async () => {
    const a = { 'gpt-5': metric(usage(100, 30, 20, 10)) };
    const b = { 'gpt-5': metric(usage(150, 40, 30, 10)), 'claude-sonnet-4.5': metric(usage(80, 20, 10)) };
    const t = await parsed([
      prompt('First task'), answer('First answer'),
      event('session.usage_checkpoint', { accountingSnapshot: { modelMetrics: a } }),
      event('session.shutdown', { modelMetrics: a }),
      event('session.resume', { selectedModel: 'claude-sonnet-4.5' }), prompt('Resume task'),
      answer('Resumed answer'), event('session.model_change', { newModel: 'gpt-5' }),
      event('session.usage_checkpoint', { accountingSnapshot: { modelMetrics: b } }),
      event('session.shutdown', { modelMetrics: b }),
    ]);
    expect(t.requests.map((r) => [r.model, r.usage.input, r.usage.cacheRead, r.usage.cache5m, r.usage.output])).toEqual([
      ['gpt-5', 60, 30, 10, 20], ['gpt-5', 40, 10, 0, 10], ['claude-sonnet-4.5', 60, 20, 0, 10],
    ]);
    expect(t.requests.every((r) => r.contextTokens === 0 && r.messageId.startsWith('copilot-aggregate-'))).toBe(true);
    expect(t.meta.usageIncomplete).toBeUndefined();
    expect(t.messages.map((m) => m.preview)).toEqual(['First task', 'First answer', 'Resume task', 'Resumed answer']);
  });

  it('deduplicates event and call identities, reconciles per-call usage with aggregate residuals', async () => {
    const first = answer('Read complete', { apiCallId: 'call-one' });
    const u = event('assistant.usage', { model: 'gpt-5', apiCallId: 'call-one', ...usage(100, 40, 20), cost: 9000 });
    const t = await parsed([
      prompt('Read file'), first, first, u,
      event('assistant.usage', { model: 'gpt-5', apiCallId: 'call-one', ...usage(100, 40, 20) }),
      answer('More work'), event('session.shutdown', { modelMetrics: { 'gpt-5': metric(usage(150, 50, 30)) } }),
    ]);
    expect(t.promptCount).toBe(1);
    expect(t.messages.filter((m) => m.preview === 'Read complete')).toHaveLength(1);
    expect(t.requests.map((r) => [r.usage.input, r.usage.cacheRead, r.usage.output, r.contextTokens])).toEqual([[60, 40, 20, 100], [40, 10, 10, 0]]);
    expect(t.meta.usageIncomplete).toBeUndefined();
  });

  it('keeps messages, tools, title, compaction and malformed-line counts without inventing usage', async () => {
    const t = await parsed([
      prompt('Read café.ts'), '{malformed', answer('Inspecting'),
      event('tool.execution_start', { toolCallId: 'tool-one', toolName: 'read_file', arguments: { path: 'café.ts' } }),
      event('tool.execution_complete', { toolCallId: 'tool-one', success: false, error: { message: 'Synthetic failure' } }),
      event('session.title_changed', { title: 'Synthetic session' }),
      event('session.compaction_complete', { success: true, summaryContent: 'Synthetic summary' }),
    ]);
    expect(t.requests).toEqual([]);
    expect(t.meta).toMatchObject({ parseErrors: 1, cwd: '/workspace/example', version: '1.0', usageIncomplete: true });
    expect(t.facts?.customTitle).toBe('Synthetic session');
    expect(t.toolCalls[0]).toMatchObject({ name: 'read_file', toolUseId: 'tool-one', isError: true, resultPreview: 'Synthetic failure', requestSeq: -1 });
    expect(t.compactions).toHaveLength(1);
    expect(t.promptCount).toBe(1);
  });

  it('marks missing and trailing usage incomplete rather than treating missing counters as zero', async () => {
    const t = await parsed([prompt('Partial'), answer('Before checkpoint'),
      event('session.shutdown', { modelMetrics: { 'gpt-5': metric(usage(100, 20, 10)), unknown: metric({ inputTokens: 200 }) } }),
      event('session.resume', {}), answer('After checkpoint')]);
    expect(t.requests).toHaveLength(1);
    expect(t.meta.usageIncomplete).toBe(true);
    const absent = await parsed([prompt('No telemetry'), answer('No usage'), event('session.usage_info', { currentTokens: 500, tokenLimit: 1000 })]);
    expect(absent.requests).toEqual([]);
    expect(absent.meta.usageIncomplete).toBe(true);
  });

  it('does not let one metered call certify other responses with missing usage', async () => {
    const t = await parsed([prompt('First'), answer('Unmetered answer'),
      prompt('Second'), answer('Metered answer', { apiCallId: 'call-b' }),
      event('assistant.usage', { model: 'gpt-5', apiCallId: 'call-b', ...usage(100, 30, 20) })]);
    expect(t.requests).toHaveLength(1);
    expect(t.meta.usageIncomplete).toBe(true);
    const exact = await parsed([prompt('Exact'), answer('Metered answer', { apiCallId: 'call-only' }),
      event('assistant.usage', { model: 'gpt-5', apiCallId: 'call-only', ...usage(100, 30, 20) })]);
    expect(exact.requests).toHaveLength(1);
    expect(exact.meta.usageIncomplete).toBeUndefined();
    const beforeMessage = await parsed([prompt('Usage arrives first'),
      event('assistant.usage', { model: 'gpt-5', apiCallId: 'call-before', ...usage(100, 30, 20) }),
      answer('Metered answer', { apiCallId: 'call-before' })]);
    expect(beforeMessage.meta.usageIncomplete).toBeUndefined();
  });

  it('flags decreasing process counters on resume as partial rather than inventing their provenance', async () => {
    const t = await parsed([prompt('First'), answer('First answer'),
      event('session.shutdown', { modelMetrics: { 'gpt-5': metric(usage(100, 30, 20)) } }),
      event('session.resume', {}), prompt('Resumed'), answer('Resumed answer'),
      event('session.shutdown', { modelMetrics: { 'gpt-5': metric(usage(50, 10, 5)) } })]);
    expect(t.requests).toHaveLength(1);
    expect(t.meta.usageIncomplete).toBe(true);
  });

  it('preserves recorded zero usage and does not let repeated stale snapshots cover new output', async () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const snapshot = { modelMetrics: { 'gpt-5': metric(zero) } };
    const recorded = await parsed([prompt('Zero usage'), answer('Recorded zero'), event('session.shutdown', snapshot), event('session.shutdown', snapshot)]);
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.requests[0]?.usage.input).toBe(0);
    expect(recorded.meta.usageIncomplete).toBeUndefined();
    const stale = await parsed([prompt('First'), answer('Covered'), event('session.shutdown', snapshot),
      event('session.resume', {}), prompt('More'), answer('Uncovered'), event('session.shutdown', snapshot)]);
    expect(stale.requests).toHaveLength(1);
    expect(stale.meta.usageIncomplete).toBe(true);
  });

  it('normalizes tool shapes and excludes streaming deltas and request multipliers', () => {
    expect(normalizeCopilotLine(event('assistant.message_delta', { deltaContent: 'repeated' }))).toBeUndefined();
    expect(normalizeCopilotLine(event('tool.execution_start', { toolCallId: 'mcp-one', toolName: 'read', mcpServerName: 'docs', arguments: '{"key":"value"}' }))).toMatchObject({ message: { content: [{ type: 'tool_use', name: 'mcp__docs__read', input: { key: 'value' } }] } });
    expect(copilotUsage({ ...usage(100, 40, 20, 10), cost: 1000, reasoningTokens: 40 })).toEqual({ input_tokens: 50, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 20, output_tokens_details: { thinking_tokens: 20 } });
  });
});

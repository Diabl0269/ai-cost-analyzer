import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverSessionsWithWarnings } from '../../../core/discover.js';
import { readLineAt } from '../../../core/jsonl.js';
import { parseSession } from '../../../core/parse/session.js';
import { blocksForLine } from '../../../core/db/transcript.js';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const line = (type: string, payload: unknown) => ({ type, timestamp: '2026-01-01T00:00:00.000Z', payload });
const usage = (input: number, cached: number, output: number, thinking: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: thinking, total_tokens: input + output });
const message = (role: string, text: string) => line('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
const counter = (total: unknown, last: unknown = total) => line('event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } });
async function root() {
  const p = await mkdtemp(path.join(tmpdir(), 'cca-codex-')); cleanup.push(p); return p;
}
async function rollout(root: string, name: string, id: string, rows: unknown[], metadata: object = {}) {
  const p = path.join(root, name);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, [line('session_meta', { id, cwd: '/workspace/example', cli_version: '1.0', git: { branch: 'main' }, ...metadata }), ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
async function parsed(rows: unknown[]) {
  const r = await root();
  const p = await rollout(r, 'sessions/2026/01/01/rollout-test.jsonl', 'test', rows);
  const found = await discoverSessionsWithWarnings([r]);
  expect(found.warnings).toEqual([]);
  return { session: await parseSession(found.sessions[0]!), file: p };
}

describe('Codex rollout adapter', () => {
  it('deduplicates modern records and mirrored cumulative events, with cache/reasoning subsets', async () => {
    const u = usage(100, 40, 20, 12);
    const { session, file } = await parsed([
      message('user', 'Read café.ts'), line('turn_context', { model: 'gpt-5', effort: 'high' }),
      line('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect the file.' }] }),
      line('response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"cat café.ts"}' }),
      line('token_usage_record', { response_id: 'response-1', usage: u, thread_token_usage: u }),
      line('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'Synthetic file text' }),
      counter(u), counter(u),
      message('assistant', 'Finished reading.'), counter(u),
    ]);
    expect(session.main.requests).toHaveLength(1);
    expect(session.main.requests[0]).toMatchObject({ model: 'gpt-5', effort: 'high', contextTokens: 100, usage: { input: 60, cacheRead: 40, output: 20, thinking: 12 } });
    expect(session.main.toolCalls[0]).toMatchObject({ toolUseId: 'call-1', name: 'exec_command', resultChars: 19, resultShape: 'string', resultPreview: 'Synthetic file text' });
    expect(session.main.promptCount).toBe(1);
    expect(session.main.meta.usageIncomplete).toBeUndefined();
    expect(session.main.meta).toMatchObject({ cwd: '/workspace/example', gitBranch: 'main', firstPrompt: 'Read café.ts' });
    expect(session.main.messages.some((m) => m.searchText === 'Finished reading.')).toBe(true);
    for (const m of session.main.messages) {
      const raw = JSON.parse(await readLineAt(file, m.range)) as Record<string, unknown>;
      expect(blocksForLine(raw).length).toBeGreaterThan(0);
    }
    expect(blocksForLine(JSON.parse(await readLineAt(file, session.main.messages.find((m) => m.kind === 'prompt')!.range)))).toEqual([{ type: 'text', text: 'Read café.ts' }]);
  });

  it('uses legacy cumulative deltas, handles resets and model changes, and excludes prompt echoes', async () => {
    const a = usage(100, 40, 20, 10);
    const b = usage(250, 90, 50, 22);
    const c = usage(30, 10, 5, 2);
    const { session } = await parsed([
      line('event_msg', { type: 'user_message', message: 'First prompt' }), message('user', 'First prompt'),
      line('turn_context', { model: 'gpt-5', effort: 'medium' }), message('assistant', 'One'), counter(a), counter(a),
      message('assistant', 'Two'), counter(b, usage(150, 50, 30, 12)),
      message('user', 'Resume'), line('turn_context', { model: 'gpt-5.1', effort: 'low' }), message('assistant', 'Three'), counter(c),
      line('compacted', { message: 'Synthetic summary' }),
      message('assistant', 'Unreported text'),
    ]);
    expect(session.main.requests.map((r) => [r.model, r.usage.input, r.usage.cacheRead, r.usage.output])).toEqual([
      ['gpt-5', 60, 40, 20], ['gpt-5', 100, 50, 30], ['gpt-5.1', 20, 10, 5],
    ]);
    expect(session.main.promptCount).toBe(2);
    expect(session.main.compactions).toHaveLength(1);
    expect(session.main.injections.some((i) => i.kind === 'compact_summary')).toBe(true);
    expect(session.main.messages.find((m) => m.preview === 'Unreported text')?.requestSeq).toBeUndefined();
  });

  it('keeps event-only requests in mixed-format logs while skipping counted response echoes', async () => {
    const { session } = await parsed([
      message('user', '<environment_context><cwd>/workspace/example</cwd></environment_context>'),
      line('event_msg', { type: 'user_message', message: 'Actual event-only request' }),
      line('turn_context', { model: 'gpt-5' }), message('assistant', 'First answer'), counter(usage(100, 40, 20, 10)),
      line('event_msg', { type: 'user_message', message: 'Mirrored request' }), message('user', 'Mirrored request'),
      message('assistant', 'Second answer'), counter(usage(200, 80, 40, 20)),
      line('event_msg', { type: 'user_message', message: 'Mirrored request' }),
      message('assistant', 'Third answer'), counter(usage(300, 120, 60, 30)),
    ]);
    expect(session.main.meta.firstPrompt).toBe('Actual event-only request');
    expect(session.main.promptCount).toBe(3);
    expect(session.main.requests.map((request) => request.turnIndex)).toEqual([1, 2, 3]);
  });

  it('keeps unknown models unknown and does not bill a resumed cumulative baseline', async () => {
    const { session } = await parsed([
      message('user', 'Resume old session'), message('assistant', 'A response'),
      counter(usage(10000, 4000, 2000, 1000), usage(100, 40, 20, 10)),
    ]);
    expect(session.main.requests).toHaveLength(1);
    expect(session.main.requests[0]).toMatchObject({ model: '', usage: { input: 60, output: 20 } });
  });

  it('treats an initial legacy counter without assistant output as a resumed baseline', async () => {
    const inherited = usage(10000, 4000, 2000, 1000);
    const previous = usage(300, 100, 40, 20);
    const current = usage(10100, 4040, 2020, 1010);
    const { session } = await parsed([
      message('user', 'Resume'), line('turn_context', { model: 'gpt-5' }),
      counter(inherited, previous),
      message('assistant', 'Current response'), counter(current, usage(100, 40, 20, 10)),
    ]);
    expect(session.main.requests).toHaveLength(1);
    expect(session.main.requests[0]).toMatchObject({ usage: { input: 60, cacheRead: 40, output: 20, thinking: 10 } });
  });

  it('retains an explicit modern usage record even without visible assistant output', async () => {
    const u = usage(100, 40, 20, 10);
    const { session } = await parsed([
      message('user', 'Hidden response'), line('turn_context', { model: 'gpt-5' }),
      line('token_usage_record', { response_id: 'hidden-response', usage: u, thread_token_usage: u }),
    ]);
    expect(session.main.requests).toHaveLength(1);
    expect(session.main.requests[0]).toMatchObject({ usage: { input: 60, output: 20 } });
  });

  it('preserves explicit fast mode and lets reported service tier override requested mode', async () => {
    const u = usage(100, 40, 20, 10);
    const { session } = await parsed([
      message('user', 'Priority requested'), line('turn_context', { model: 'gpt-5', service_tier: 'priority' }),
      message('assistant', 'Priority response'), line('token_usage_record', { response_id: 'fast-1', usage: u }),
      message('user', 'Actual standard'), line('turn_context', { model: 'gpt-5', speed: 'fast' }),
      message('assistant', 'Standard response'), line('token_usage_record', { response_id: 'fast-2', service_tier: 'default', usage: u }),
      message('user', 'Actual priority'), line('turn_context', { model: 'gpt-5' }),
      message('assistant', 'Reported fast response'), line('token_usage_record', { response_id: 'fast-3', usage: { ...u, service_tier: 'priority' } }),
      message('user', 'Fast speed'), line('turn_context', { model: 'gpt-5', speed: 'fast' }),
      message('assistant', 'Fast response'), line('token_usage_record', { response_id: 'fast-4', usage: u }),
      message('user', 'Unknown requested tier'), line('turn_context', { model: 'gpt-5', service_tier: 'unsupported' }),
      message('assistant', 'No inferred discount'), line('token_usage_record', { response_id: 'fast-5', usage: u }),
    ]);
    expect(session.main.requests.map((r) => [r.speed, r.serviceTier])).toEqual([
      ['fast', 'priority'], ['standard', 'standard'], ['fast', 'priority'], ['fast', 'priority'], ['standard', 'standard'],
    ]);
  });

  it('flags missing usage without inventing a billed request', async () => {
    const { session } = await parsed([message('user', 'Hello'), message('assistant', 'No telemetry')]);
    expect(session.main.requests).toEqual([]);
    expect(session.main.meta.usageIncomplete).toBe(true);
    expect(session.main.messages.map((m) => m.preview)).toEqual(['Hello', 'No telemetry']);
  });

  it('keeps distinct cwd values whose Claude-style encodings would collide separate', async () => {
    const r = await root();
    await rollout(r, 'sessions/2026/01/01/rollout-a.jsonl', 'a', [], { cwd: '/workspace/foo-bar' });
    await rollout(r, 'sessions/2026/01/01/rollout-b.jsonl', 'b', [], { cwd: '/workspace/foo/bar' });
    const found = await discoverSessionsWithWarnings([r]);
    expect(found.sessions).toHaveLength(2);
    expect(new Set(found.sessions.map((s) => s.projectDirName)).size).toBe(2);
  });

  it('deduplicates overlapping roots, canonical paths, archives and cyclic links; attaches children once', async () => {
    const r = await root();
    await rollout(r, 'sessions/2026/01/01/rollout-parent.jsonl', 'parent', [message('user', 'Parent')]);
    await rollout(r, 'archived_sessions/rollout-parent-copy.jsonl', 'parent', [message('user', 'Parent'), message('assistant', 'Larger copy')]);
    await rollout(r, 'sessions/2026/01/01/rollout-child.jsonl', 'child', [message('user', 'Child')], { source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } });
    await symlink(path.join(r, 'sessions'), path.join(r, 'sessions/2026/01/01/2026'));
    await symlink(path.join(r, 'sessions/2026/01/01/rollout-child.jsonl'), path.join(r, 'sessions/rollout-child-link.jsonl'));
    await mkdir(path.join(r, 'unrelated'), { recursive: true });
    await rollout(r, 'unrelated/rollout-ignore.jsonl', 'ignored', []);
    const found = await discoverSessionsWithWarnings([r, path.join(r, 'sessions'), path.join(r, 'sessions/2026/01/01'), path.join(r, 'archived_sessions')]);
    expect(found.warnings).toEqual([]);
    expect(found.sessions.map((s) => s.sessionId)).toEqual(['codex-parent']);
    expect(found.sessions[0]).toMatchObject({ provider: 'codex', projectDirName: `codex-project-${Buffer.from('/workspace/example').toString('base64url')}` });
    expect(found.sessions[0]!.mainFile.path).toContain('archived_sessions');
    expect(found.sessions[0]!.agentFiles.map((f) => f.agentId)).toEqual(['child']);
    expect((await parseSession(found.sessions[0]!)).agents).toHaveLength(1);
  });
});

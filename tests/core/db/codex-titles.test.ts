import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSessions } from '../../../core/discover.js';
import { parseSession } from '../../../core/parse/session.js';
import { runIndex } from '../../../core/db/indexer.js';
import { getTranscriptPage } from '../../../core/db/transcript.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const row = (type: string, payload: object) => ({ type, timestamp: '2026-01-01T12:00:00.000Z', payload });
const message = (role: string, text: string) => row('response_item', { type: 'message', role, content: [{ type: 'input_text', text }] });
async function fixture(id: string, messages: object[], metadata: object = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'cca-codex-title-')); roots.push(root);
  const dir = path.join(root, 'sessions'); await mkdir(dir);
  await writeFile(path.join(dir, 'rollout-synthetic.jsonl'), [row('session_meta', { id, cwd: '/workspace/synthetic', ...metadata }), ...messages].map((value) => JSON.stringify(value)).join('\n') + '\n');
  return { root, dbPath: path.join(root, 'index.sqlite') };
}

describe('Codex persisted titles and prompts', () => {
  it('uses actual mixed-envelope request, counts one prompt, attributes context, and renders original bytes', async () => {
    const injected = '# AGENTS.md instructions for /workspace/synthetic\n\n<INSTRUCTIONS>Use project conventions.</INSTRUCTIONS>\n<environment_context><cwd>/workspace/synthetic</cwd></environment_context>';
    const mixed = '<in-app-browser-context tab="synthetic">Selected browser tab.</in-app-browser-context>\n## Open tabs:\nEditor state\n## My request:\nFix café rendering.';
    const { root, dbPath } = await fixture('synthetic-title', [
      message('user', injected), message('developer', 'Developer context'), message('user', mixed),
      row('turn_context', { model: 'gpt-5' }), message('assistant', 'Working on it.'),
      row('token_usage_record', { response_id: 'title-response', usage: { input_tokens: 100, output_tokens: 10 } }),
    ]);
    const discovered = await discoverSessions([root]);
    const parsed = await parseSession(discovered[0]!);
    expect(parsed.main.promptCount).toBe(1);
    expect(parsed.main.meta.firstPrompt).toBe('Fix café rendering.');
    expect(parsed.main.messages.map((m) => m.kind)).toEqual(['meta', 'meta', 'prompt', 'assistant']);
    expect(parsed.main.messages.find((m) => m.kind === 'prompt')).toMatchObject({ searchText: 'Fix café rendering.', turnIndex: 1 });
    expect(parsed.main.injections.filter((i) => i.name === 'codex_context')).toHaveLength(3);
    expect(parsed.main.injections.find((i) => i.kind === 'user_prompt')?.chars).toBe('Fix café rendering.'.length);
    await runIndex({ roots: [root], dbPath });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT title, titleSource, firstPrompt, promptCount FROM sessions').get()).toEqual({ title: 'Fix café rendering.', titleSource: 'first-prompt', firstPrompt: 'Fix café rendering.', promptCount: 1 });
      const page = await getTranscriptPage(db, 'codex-synthetic-title', null, 0, 20, new Map());
      expect(page?.messages[0]?.blocks).toEqual([{ type: 'text', text: injected }]);
      expect(page?.messages.find((m) => m.kind === 'prompt')?.blocks).toEqual([{ type: 'text', text: mixed }]);
    } finally { db.close(); }
  });

  it('cleans Automation title while retaining original searchable prompt and transcript metadata', async () => {
    const original = 'Automation: Daily summary\nAutomation ID: daily-summary\nAutomation memory: $CODEX_HOME/automations/daily-summary/memory.md\n\nSummarize the current work.';
    const { root, dbPath } = await fixture('automation-title', [message('user', original)]);
    const parsed = await parseSession((await discoverSessions([root]))[0]!);
    expect(parsed.main.messages[0]).toMatchObject({ searchText: original, kind: 'prompt', turnIndex: 1 });
    expect(parsed.main.meta.firstPrompt).toContain('Automation ID: daily-summary');
    expect(parsed.main.promptCount).toBe(1);
    await runIndex({ roots: [root], dbPath });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT title, titleSource FROM sessions').get()).toEqual({ title: 'Daily summary', titleSource: 'first-prompt' });
      const page = await getTranscriptPage(db, 'codex-automation-title', null, 0, 20, new Map());
      expect(page?.messages[0]?.blocks).toEqual([{ type: 'text', text: original }]);
    } finally { db.close(); }
  });

  it('keeps explicit metadata title priority over the actual user request', async () => {
    const { root, dbPath } = await fixture('metadata-title', [message('user', 'Actual task')], { custom_title: 'Chosen title', ai_title: 'Generated title' });
    await runIndex({ roots: [root], dbPath });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { expect(db.prepare('SELECT title, titleSource FROM sessions').get()).toEqual({ title: 'Chosen title', titleSource: 'custom-title' }); }
    finally { db.close(); }
  });

  it('uses a distinct full Codex id when context-only sessions have no request', async () => {
    const { root, dbPath } = await fixture('019aaa00-0000-4000-8000-000000000001', [message('user', '<environment_context><cwd>/workspace/synthetic</cwd></environment_context>')]);
    await runIndex({ roots: [root], dbPath });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { expect(db.prepare('SELECT title, promptCount FROM sessions').get()).toEqual({ title: 'Codex 019aaa00-0000-4000-8000-000000000001', promptCount: 0 }); }
    finally { db.close(); }
  });
});

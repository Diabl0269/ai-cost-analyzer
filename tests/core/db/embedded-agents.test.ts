import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runIndex } from '../../../core/db/indexer.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { buildFixture } from './fixture.js';

const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true }); });
function temp() { const root = mkdtempSync(join(tmpdir(), 'cca-embedded-')); scratch.push(root); return root; }

describe('embedded agent indexing', () => {
  it('indexes legacy sidechain aliases once and continues to the next session', async () => {
    const root = temp();
    const project = join(root, 'projects', '-workspace-synthetic');
    mkdirSync(project, { recursive: true });
    const envelope = { timestamp: '2026-01-01T00:00:00.000Z', cwd: '/workspace/synthetic' };
    const user = (text: string, extra = {}) => ({ ...envelope, type: 'user', message: { content: text }, ...extra });
    const assistant = (id: string, input: number, output: number, extra = {}) => ({ ...envelope, type: 'assistant', uuid: id, message: {
      id, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Synthetic answer' }], usage: { input_tokens: input, output_tokens: output },
    }, ...extra });
    const embedded = { isSidechain: true, agentId: 'child-synthetic' };
    writeFileSync(join(project, 'a-legacy.jsonl'), [
      user('First session'), assistant('main-response', 3, 4),
      user('Child task', embedded), assistant('child-response', 5, 6, embedded),
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(project, 'z-next.jsonl'), [user('Later session'), assistant('later-response', 7, 8)].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const dbPath = join(root, 'index.sqlite');
    const result = await runIndex({ roots: [join(root, 'projects')], dbPath });
    expect(result.sessionsIndexed).toBe(2);
    expect(result.parseErrors).toBe(0);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT id, requestCount, agentCount FROM sessions ORDER BY id').all()).toEqual([
        { id: 'a-legacy', requestCount: 2, agentCount: 1 }, { id: 'z-next', requestCount: 1, agentCount: 0 },
      ]);
      expect(db.prepare('SELECT COUNT(*) n FROM agents').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) n, SUM(input) input, SUM(output) output FROM requests').get()).toEqual({ n: 3, input: 15, output: 18 });
      expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 6 });
      expect(db.prepare('SELECT COUNT(*) n FROM injections').get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });

  it('preserves distinct workflow agents reusing the plain agent id', async () => {
    const root = temp();
    const fixture = buildFixture(root);
    const agent = fixture.session.agents[0]!;
    fixture.session.workflowRuns = ['wf_first', 'wf_second'].map((runId) => {
      const workflowAgent = structuredClone(agent);
      workflowAgent.file = { ...workflowAgent.file, kind: 'workflow-agent', path: join(root, `${runId}.jsonl`), runId };
      writeFileSync(workflowAgent.file.path, '{}\n');
      return { runId, dir: root, agents: [workflowAgent], journal: { started: 0, result: 0, failed: 0 } };
    });
    fixture.discovered.workflowRuns = fixture.session.workflowRuns.map((run) => ({ runId: run.runId, dir: run.dir, agentFiles: run.agents.map((a) => a.file) }));
    const dbPath = join(root, 'index.sqlite');
    const result = await runIndex({
      roots: [root], dbPath, pricing: defaultPricing(),
      discover: async () => [fixture.discovered], parse: async () => fixture.session,
    });
    expect(result.sessionsIndexed).toBe(1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const agents = db.prepare('SELECT agentId, runId FROM agents ORDER BY runId').all();
      expect(agents).toHaveLength(3);
      expect(new Set(agents.map((row) => row.agentId)).size).toBe(3);
      expect(agents.map((row) => row.runId)).toEqual([null, 'wf_first', 'wf_second']);
      expect(agents[0]!.agentId).toBe(agent.agentId);
      expect(db.prepare('SELECT agentId, runId FROM files WHERE runId IS NOT NULL ORDER BY runId').all()).toEqual(agents.slice(1));
      const secondPass = await runIndex({
        roots: [root], dbPath, pricing: defaultPricing(),
        discover: async () => [fixture.discovered], parse: async () => fixture.session,
      });
      expect(secondPass.sessionsSkipped).toBe(1);
      expect(secondPass.sessionsIndexed).toBe(0);
      expect(db.prepare('SELECT COUNT(*) n FROM requests WHERE agentId != ?').get('')).toEqual({ n: agent.requests.length * 3 });
    } finally { db.close(); }
  });
});

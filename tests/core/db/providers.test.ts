import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runIndex } from '../../../core/db/indexer.js';
import { createStore } from '../../../core/db/store.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { defaultSettings } from '../../../core/settings.js';
import { rangeQuerySchema } from '../../../server/schemas.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const range = { from: '2000-01-01', to: '2100-01-01' };
it('indexes both providers into a shared folder and scopes every aggregate, search and export', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aca-providers-')); homes.push(home);
  const dbPath = join(home, 'index.sqlite');
  const roots = [resolve('tests/fixtures/projects'), resolve('tests/fixtures/codex')];
  const pricing = defaultPricing();
  const ctx = { pricing, settings: { ...defaultSettings(), hideScratchProjects: false }, now: new Date('2026-09-07T12:00:00Z') };
  await runIndex({ dbPath, roots, pricing });
  const store = createStore(dbPath);
  try {
    const all = await store.listSessions(range, ctx);
    const codex = await store.listSessions({ ...range, provider: 'codex' }, ctx);
    const claude = await store.listSessions({ ...range, provider: 'claude' }, ctx);
    expect(all.total).toBe(6);
    expect(codex.total).toBe(1);
    expect(claude.total).toBe(5);
    expect(all.totalCost).toBeCloseTo(claude.totalCost + codex.totalCost, 10);
    const session = codex.sessions[0]!;
    expect(session.provider).toBe('codex');
    expect(session.tokens).toMatchObject({ input: 600, cacheRead: 400, output: 100, thinking: 20 });
    expect(session.cost.total).toBeCloseTo(0.00252, 10);
    const projects = await store.listProjects(ctx, range);
    const alpha = projects.projects.find(p => p.path === '/Users/dev/projects/alpha')!;
    expect(alpha).toBeDefined();
    expect(session.projectId).toBe(alpha.id);
    const folder = await store.listSessions({ ...range, project: alpha.id }, ctx);
    expect(new Set(folder.sessions.map(s => s.provider))).toEqual(new Set(['claude', 'codex']));
    const overview = await store.overview({ ...range, provider: 'codex' }, ctx);
    expect(overview.totals.sessions).toBe(1);
    const unknownContext = { ...ctx, pricing: { ...pricing, models: pricing.models.filter(m => m.key !== 'gpt-5.3-codex') } };
    expect((await store.overview({ ...range, provider: 'claude' }, unknownContext)).unpricedModels).toEqual([]);
    expect((await store.overview({ ...range, provider: 'codex' }, unknownContext)).unpricedModels).toEqual(['gpt-5.3-codex']);
    expect(overview.totals.cost.total).toBeCloseTo(session.cost.total, 10);
    const models = await store.modelsAnalytics({ ...range, provider: 'codex' }, ctx);
    expect(models.models.map(m => m.model)).toEqual(['gpt-5.3-codex']);
    const tools = await store.toolsAnalytics({ ...range, provider: 'codex' }, ctx);
    expect(tools.tools.map(t => t.name)).toEqual(['exec_command']);
    for (const scope of ['titles', 'everything'] as const) {
      expect((await store.search({ ...range, q: 'synthetic', scope, provider: 'codex' }, ctx)).totalSessions).toBe(1);
      expect((await store.search({ ...range, q: 'synthetic', scope, provider: 'claude' }, ctx)).totalSessions).toBe(0);
    }
    const detail = await store.getSession(session.id, ctx);
    expect(detail?.summary.provider).toBe('codex');
    const transcript = await store.getTranscript(session.id, null, 0, 200, ctx);
    expect(transcript?.messages.flatMap(m => m.blocks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', name: 'exec_command' }),
      expect.objectContaining({ type: 'tool_result', text: 'synthetic' }),
    ]));
    const csv = await store.exportSessionsCsv({ ...range, provider: 'codex' }, ctx);
    expect(csv.trim().split('\r\n')).toHaveLength(2);
    expect(csv).toContain('provider');
    expect(csv).toContain('codex');
  } finally { store.close(); }
  const repeated = await runIndex({ dbPath, roots, pricing });
  expect(repeated.sessionsSkipped).toBe(6);
});
it('validates provider at the API boundary', () => {
  expect(rangeQuerySchema.parse({ provider: 'codex' }).provider).toBe('codex');
  expect(rangeQuerySchema.safeParse({ provider: 'unknown' }).success).toBe(false);
});

it('prices long contexts per request consistently across totals, details, attribution and month budget', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aca-long-context-')); homes.push(home);
  const root = join(home, 'sessions'); mkdirSync(root);
  const rows: unknown[] = [];
  let second = 0;
  const add = (type: string, payload: unknown) => rows.push({ type, payload, timestamp: `2026-09-07T09:00:${String(second++).padStart(2, '0')}.000Z` });
  add('session_meta', { id: 'long-context', cwd: '/workspace/long-context' });
  let input = 0, output = 0, cached = 0;
  for (const context of [200000, 200000, 300000]) {
    add('turn_context', { model: 'gpt-6.1-sol' });
    add('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic long context check' }] });
    add('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic answer' }] });
    input += context; output += 100; cached += 100000;
    add('event_msg', { type: 'token_count', info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
      last_token_usage: { input_tokens: context, cached_input_tokens: 100000, output_tokens: 100 },
    } });
  }
  writeFileSync(join(root, 'rollout-long.jsonl'), rows.map(r => JSON.stringify(r)).join('\n')+'\n');
  const dbPath = join(home, 'index.sqlite'); const pricing = defaultPricing();
  const ctx = { pricing, settings: { ...defaultSettings(), hideScratchProjects: false }, now: new Date('2026-09-07T12:00:00Z') };
  await runIndex({ roots: [root], dbPath, pricing });
  const store = createStore(dbPath);
  try {
    const q = { ...range, provider: 'codex' as const };
    const list = await store.listSessions(q, ctx);
    expect(list.totalCost).toBeCloseTo(1.2435, 9);
    const detail = (await store.getSession(list.sessions[0]!.id, ctx))!;
    expect(detail.requests).toHaveLength(3);
    detail.requests.forEach((r, i) => expect(r.cost.total).toBeCloseTo([0.211, 0.211, 0.8215][i]!, 9));
    expect(detail.byModel[0]!.cost.total).toBeCloseTo(list.totalCost, 9);
    expect(detail.categories.exact.total).toBeCloseTo(list.totalCost, 9);
    const overview = await store.overview(q, ctx);
    expect(overview.totals.cost.total).toBeCloseTo(list.totalCost, 9);
    expect(overview.daily[0]!.cost).toBeCloseTo(list.totalCost, 9);
    expect(overview.budget.spent).toBeCloseTo(list.totalCost, 9);
    expect((await store.modelsAnalytics(q, ctx)).models[0]!.cost.total).toBeCloseTo(list.totalCost, 9);
    // Pricing overrides apply at read time, including the long-context threshold, without a reindex.
    const changed = { ...ctx, pricing: { ...pricing, models: pricing.models.map(m => m.key === 'gpt-6.1-sol' ? { ...m, longContext: { threshold: 999999, inputMultiplier: 2, outputMultiplier: 1.5 } } : m) } };
    expect((await store.listSessions(q, changed)).totalCost).toBeCloseTo(0.833, 9);
    expect((await store.overview({ ...range, provider: 'claude' }, ctx)).budget.spent).toBe(0);
  } finally { store.close(); }
});

it('reports missing usage even though those sessions have no request rows, scoped to provider, folder and date', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aca-coverage-')); homes.push(home);
  const root = join(home, 'sessions'); mkdirSync(root);
  const line = (type: string, payload: unknown) => ({ type, payload, timestamp: '2026-09-07T09:00:00.000Z' });
  const user = line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic request' }] });
  const assistant = line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic answer' }] });
  for (const [id, partial] of [['missing', false], ['partial', true]] as const) {
    const rows = [line('session_meta', { id, cwd: '/workspace/coverage' }), line('turn_context', { model: 'gpt-5.3-codex' }), user, assistant];
    if (partial) rows.push(line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 }, last_token_usage: { input_tokens: 100, output_tokens: 10 } } }), user, assistant);
    writeFileSync(join(root, `rollout-${id}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n')+'\n');
  }
  const dbPath = join(home, 'index.sqlite'); const pricing = defaultPricing();
  const ctx = { pricing, settings: { ...defaultSettings(), hideScratchProjects: false }, now: new Date('2026-09-07T12:00:00Z') };
  await runIndex({ roots: [root], dbPath, pricing }); const store = createStore(dbPath);
  try {
    const q = { from: '2026-09-07', to: '2026-09-07', provider: 'codex' as const };
    expect((await store.overview(q, ctx)).usageCoverage).toEqual({ unavailableSessions: 1, partialSessions: 1 });
    expect((await store.overview({ ...q, provider: 'claude' }, ctx)).usageCoverage).toEqual({ unavailableSessions: 0, partialSessions: 0 });
    expect((await store.overview({ ...q, project: '/workspace/other' }, ctx)).usageCoverage).toEqual({ unavailableSessions: 0, partialSessions: 0 });
    expect((await store.overview({ ...q, from: '2026-09-08', to: '2026-09-09' }, ctx)).usageCoverage).toEqual({ unavailableSessions: 0, partialSessions: 0 });
  } finally { store.close(); }
});

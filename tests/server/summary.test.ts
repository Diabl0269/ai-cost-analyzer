/** `GET /api/analytics/summary`: auth, shape, and the real store's provider/period semantics. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { combineSummaryUsage } from '../../core/db/analytics.js';
import { runIndex } from '../../core/db/indexer.js';
import { createStore } from '../../core/db/store.js';
import { defaultPricing } from '../../core/pricing/defaults.js';
import { defaultSettings } from '../../core/settings.js';
import type { QueryContext } from '../../core/store.js';
import type {
  DiscoveredSession,
  ParsedSession,
  Provider,
  SummaryResponse,
  SummaryUsage,
} from '../../core/types.js';
import { block, message, request, transcript, usage } from '../core/cost/builders.js';
import { authedCookieHeader, buildTestApp, jsonBody, type TestApp } from './helpers.js';

const NOW = new Date(2026, 8, 7, 12, 0, 0);
const ctx: QueryContext = { pricing: defaultPricing(), settings: { ...defaultSettings(), hideScratchProjects: false }, now: NOW };

function localTs(day: number): string {
  return new Date(2026, 8, day, 12).toISOString();
}

interface Spec {
  id: string;
  provider: Provider;
  days: number[];
  withUsage?: boolean;
  withAssistant?: boolean;
  model?: string;
}

function sessionOf(spec: Spec): ParsedSession {
  const dir = `-Users-dev-${spec.id}`;
  const file = {
    path: `/tmp/cca-summary/${dir}/${spec.id}.jsonl`,
    size: 1,
    mtimeMs: 1,
    kind: 'main' as const,
    projectDirName: dir,
    sessionId: spec.id,
  };
  const withUsage = spec.withUsage !== false;
  const main = transcript({
    file,
    meta: { cwd: `/Users/dev/${spec.id}`, firstTs: localTs(spec.days[0]!), lastTs: localTs(spec.days.at(-1)!), lineCount: 1, parseErrors: 0 },
    requests: withUsage
      ? spec.days.map((d, i) =>
          request({ seq: i, ts: localTs(d), turnIndex: 1, ...(spec.model ? { model: spec.model } : {}), usage: usage({ input: 1000, output: 100 }), blocks: [block({ type: 'text', chars: 10 })] }),
        )
      : [],
    messages: [
      message({ seq: 0, ts: localTs(spec.days[0]!), kind: 'prompt', preview: 'x' }),
      ...(spec.withAssistant ? [message({ seq: 1, ts: localTs(spec.days[0]!), kind: 'assistant', role: 'assistant', preview: 'y' })] : []),
    ],
  });
  const discovered: DiscoveredSession = {
    projectDirName: dir,
    projectDirPath: `/tmp/cca-summary/${dir}`,
    sessionId: spec.id,
    mainFile: file,
    agentFiles: [],
    workflowRuns: [],
    provider: spec.provider,
  } as DiscoveredSession;
  const session: ParsedSession = { discovered, main, agents: [], agentMeta: {}, workflowRuns: [] };
  if (!withUsage) (session.main.meta as { usageIncomplete?: boolean }).usageIncomplete = true;
  return session;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function storeFor(specs: Spec[], pricing = defaultPricing()) {
  const root = mkdtempSync(join(tmpdir(), 'cca-summary-'));
  const dbPath = join(root, 'index.sqlite');
  const sessions = specs.map(sessionOf);
  await runIndex({
    roots: [root],
    dbPath,
    pricing,
    discover: async () => sessions.map((s) => s.discovered),
    parse: async (d) => sessions.find((s) => s.discovered.sessionId === d.sessionId)!,
  });
  const store = createStore(dbPath);
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

const PER_REQUEST = (1000 * 5 + 100 * 25) / 1e6;

describe('GET /api/analytics/summary (route)', () => {
  let app: TestApp;
  afterEach(() => app?.cleanup());

  it('requires the session cookie', async () => {
    app = buildTestApp();
    const res = await app.app.request('/api/analytics/summary', { headers: { host: `127.0.0.1:${app.port}` } });
    expect(res.status).toBe(401);
  });

  it('returns periods, index state and budget', async () => {
    app = buildTestApp();
    const cookie = await authedCookieHeader(app.app, app.port);
    const res = await app.app.request('/api/analytics/summary', { headers: { host: `127.0.0.1:${app.port}`, cookie } });
    expect(res.status).toBe(200);
    const body = await jsonBody<SummaryResponse>(res);
    expect(Object.keys(body.periods).sort()).toEqual(['today', 'week']);
    expect(Object.keys(body.periods.today.byProvider).sort()).toEqual(['claude', 'codex', 'copilot', 'opencode']);
    expect(body.indexing).toBe(false);
    expect(body.lastIndexedAt).toBeNull();
    expect(body.budget.monthlyBudgetUsd).toBeNull();
    expect(body.periods.today.byProvider.codex?.cost).toBeNull();
  });
});

describe('summary aggregate (real store)', () => {
  it('splits providers and uses local today / rolling 7-day boundaries', async () => {
    const store = await storeFor([
      { id: 'a', provider: 'claude', days: [7, 7, 1, 2] },
      { id: 'b', provider: 'codex', days: [1, 7] },
      { id: 'c', provider: 'claude', days: [6] },
    ]);
    const s = await store.summary(ctx);
    expect(s.periods.today.range).toEqual({ from: '2026-09-07', to: '2026-09-07' });
    expect(s.periods.week.range).toEqual({ from: '2026-09-01', to: '2026-09-07' });
    expect(s.periods.today.byProvider.claude?.cost).toBeCloseTo(2 * PER_REQUEST, 9);
    expect(s.periods.today.byProvider.codex?.cost).toBeCloseTo(PER_REQUEST, 9);
    expect(s.periods.today.total.cost).toBeCloseTo(3 * PER_REQUEST, 9);
    expect(s.periods.week.byProvider.claude?.cost).toBeCloseTo(5 * PER_REQUEST, 9);
    expect(s.periods.week.byProvider.claude?.tokens).toMatchObject({ input: 5000, output: 500, total: 5500 });
    expect(s.periods.week.byProvider.claude?.sessions).toBe(2);
    const hidden = await store.summary({ ...ctx, settings: { ...ctx.settings, hiddenProviders: ['claude', 'copilot'] } });
    expect(Object.keys(hidden.periods.today.byProvider).sort()).toEqual(['codex', 'opencode']);
    expect(hidden.periods.today.total.cost).toBeCloseTo(PER_REQUEST, 9);
    expect(s.periods.week.byProvider.copilot).toMatchObject({ cost: 0, costStatus: 'recorded', sessions: 0 });
    store.close();
  });

  it('reports missing telemetry as unavailable, not $0', async () => {
    const store = await storeFor([{ id: 'n', provider: 'codex', days: [7], withUsage: false, withAssistant: true }]);
    const s = await store.summary(ctx);
    const codex = s.periods.today.byProvider.codex;
    expect(codex?.cost).toBeNull();
    expect(codex?.costStatus).toBe('unavailable');
    expect(codex?.unavailableSessions).toBe(1);
    expect(s.periods.today.total.cost).toBeNull();
    expect(s.periods.today.total.costStatus).toBe('unavailable');
    store.close();
  });

  it('does not count prompt-only sessions as assistant usage', async () => {
    const store = await storeFor([{ id: 'prompt-only', provider: 'claude', days: [7], withUsage: false }]);
    const sessions = await store.listSessions({ provider: 'claude', from: '2026-09-07', to: '2026-09-07' }, ctx);
    expect(sessions.total).toBe(1);
    const summary = await store.summary(ctx);
    expect(summary.periods.today.byProvider.claude).toMatchObject({
      cost: 0,
      costStatus: 'recorded',
      sessions: 0,
      unavailableSessions: 0,
    });
    store.close();
  });
});

describe('summary estimates', () => {
  it('reports estimate-only usage separately and never inside recorded cost', async () => {
    const pricing = defaultPricing();
    pricing.estimateAs = { 'codex-auto-review': 'opus-5' };
    const store = await storeFor(
      [
        { id: 'r', provider: 'codex', days: [7], model: 'codex-auto-review' },
        { id: 'a', provider: 'claude', days: [7] },
      ],
      pricing,
    );
    const s = await store.summary({ ...ctx, pricing });
    const codex = s.periods.today.byProvider.codex;
    expect(codex?.cost).toBeNull();
    expect(codex?.costStatus).toBe('unpriced');
    expect(codex?.estimatedCost).toBeCloseTo(PER_REQUEST, 9);
    expect(s.periods.today.byProvider.claude?.estimatedCost).toBeUndefined();
    expect(s.periods.today.total.cost).toBeCloseTo(PER_REQUEST, 9);
    expect(s.periods.today.total.estimatedCost).toBeCloseTo(PER_REQUEST, 9);
    store.close();
  });
});

describe('combineSummaryUsage', () => {
  const part = (cost: number | null, costStatus: SummaryUsage['costStatus'], sessions = 1): SummaryUsage => ({
    cost,
    costStatus,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: sessions ? 2 : 0 },
    sessions,
    unavailableSessions: 0,
    partialSessions: 0,
  });

  it('marks a known total partial when a provider is unavailable', () => {
    const total = combineSummaryUsage([part(2, 'recorded'), part(null, 'unavailable', 0)]);
    expect(total).toMatchObject({ cost: 2, costStatus: 'partial' });
  });

  it('ignores idle providers', () => {
    const total = combineSummaryUsage([part(2, 'recorded'), part(0, 'recorded', 0)]);
    expect(total).toMatchObject({ cost: 2, costStatus: 'recorded' });
  });
});

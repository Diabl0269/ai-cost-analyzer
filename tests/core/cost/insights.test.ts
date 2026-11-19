/**
 * The words the insights engine puts on screen. Every one of these titles is a sentence a reader
 * sees verbatim on `/insights` and on the overview, so the copy rules are asserted here rather
 * than left to a review: a count of one reads as a count of one, a project is named the way the
 * rest of the app names it, and a hook with no name in the transcript is described, not labelled
 * `(unnamed)`.
 */
import { describe, expect, it } from 'vitest';
import { computeInsights, type InsightHookRow, type InsightSessionRow, type InsightsInput } from '../../../core/cost/insights.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { defaultSettings } from '../../../core/settings.js';

const ctx = { pricing: defaultPricing(), settings: defaultSettings() };

function input(partial: Partial<InsightsInput> = {}): InsightsInput {
  return { totalCost: 100, sessions: [], sessionModels: [], tools: [], hooks: [], harnessCost: 0, hookCost: 0, ...partial };
}

function session(partial: Partial<InsightSessionRow> = {}): InsightSessionRow {
  return {
    sessionId: 's1',
    title: 'Rename the helper in utils.ts',
    projectId: 'p1',
    projectPath: '/Users/dev/work/lumen-web',
    cost: 10,
    promptCount: 10,
    requestCount: 10,
    contextTokensTotal: 100_000,
    compactionCount: 0,
    rewarmCost: 0,
    coldCacheRequests: 0,
    coldCacheCost: 0,
    idleGapExpiries: 0,
    idleGapCost: 0,
    ...partial,
  };
}

function hook(partial: Partial<InsightHookRow> = {}): InsightHookRow {
  return { hookName: 'PostToolUse:Edit', runs: 4, failures: 0, totalDurationMs: 60_000, estCost: 0.5, ...partial };
}

function titleOf(insights: ReturnType<typeof computeInsights>, id: string): string {
  const found = insights.find((insight) => insight.id === id);
  expect(found, `insight ${id}`).toBeDefined();
  return found?.title ?? '';
}

describe('insight titles agree with their counts', () => {
  it('says "1 compaction costs", not "1 compactions cost"', () => {
    const one = computeInsights(input({ sessions: [session({ compactionCount: 1, rewarmCost: 3 })] }), ctx);
    expect(titleOf(one, 'compaction-rewarm')).toMatch(/^1 compaction costs \$/);

    const many = computeInsights(
      input({
        sessions: [session({ compactionCount: 2, rewarmCost: 3 }), session({ sessionId: 's2', compactionCount: 1, rewarmCost: 1 })],
      }),
      ctx,
    );
    expect(titleOf(many, 'compaction-rewarm')).toMatch(/^3 compactions cost \$/);
    expect(many.find((i) => i.id === 'compaction-rewarm')?.explanation).toContain('2 sessions compacted');
  });

  it('says "1 cold-cache request costs"', () => {
    const one = computeInsights(input({ sessions: [session({ coldCacheRequests: 1, coldCacheCost: 2 })] }), ctx);
    expect(titleOf(one, 'cold-cache')).toMatch(/^1 cold-cache request costs \$/);

    const many = computeInsights(input({ sessions: [session({ coldCacheRequests: 12, coldCacheCost: 2 })] }), ctx);
    expect(titleOf(many, 'cold-cache')).toMatch(/^12 cold-cache requests cost \$/);
  });

  it('says "1 session ran above", not "1 sessions ran above"', () => {
    const one = computeInsights(input({ sessions: [session({ requestCount: 2, contextTokensTotal: 1_000_000 })] }), ctx);
    expect(titleOf(one, 'long-context-sessions')).toMatch(/^1 session ran above /);

    const two = computeInsights(
      input({
        sessions: [
          session({ requestCount: 2, contextTokensTotal: 1_000_000 }),
          session({ sessionId: 's2', requestCount: 2, contextTokensTotal: 1_000_000 }),
        ],
      }),
      ctx,
    );
    expect(titleOf(two, 'long-context-sessions')).toMatch(/^2 sessions ran above /);
  });

  it('pluralizes cache expiries irregularly and agrees the verb', () => {
    const one = computeInsights(input({ sessions: [session({ idleGapExpiries: 1, idleGapCost: 1 })] }), ctx);
    expect(titleOf(one, 'idle-gap-expiry')).toMatch(/^1 cache expiry after idle gaps costs \$/);

    const many = computeInsights(input({ sessions: [session({ idleGapExpiries: 4, idleGapCost: 1 })] }), ctx);
    expect(titleOf(many, 'idle-gap-expiry')).toMatch(/^4 cache expiries after idle gaps cost \$/);
  });

  it('counts a single tool call in the singular', () => {
    const one = computeInsights(
      input({ tools: [{ name: 'Read', calls: 1, genCost: 0, ingestCost: 0, carryCost: 2, topSessions: [] }] }),
      ctx,
    );
    expect(one.find((i) => i.id === 'tool-carry-cost')?.explanation).toContain('1 call.');
  });
});

describe('insights name things the way the rest of the app does', () => {
  it('uses the project name, not its absolute path', () => {
    const insights = computeInsights(input({ sessions: [session({ promptCount: 7, cost: 7 })] }), ctx);
    const title = titleOf(insights, 'cost-per-prompt-by-project');
    expect(title).toMatch(/^lumen-web costs \$/);
    expect(title).not.toContain('/Users/');
  });

  it('names a worktree the way the project tree does', () => {
    const insights = computeInsights(
      input({
        sessions: [session({ projectPath: '/Users/dev/oss/tinyvec/.claude/worktrees/feat-quantize', promptCount: 7, cost: 7 })],
      }),
      ctx,
    );
    expect(titleOf(insights, 'cost-per-prompt-by-project')).toMatch(/^tinyvec · feat-quantize costs \$/);
  });

  it('describes an unnamed hook instead of printing "(unnamed)"', () => {
    const withEvent = computeInsights(input({ hooks: [hook({ hookName: '(unnamed)', hookEvent: 'Stop', runs: 1 })] }), ctx);
    expect(titleOf(withEvent, 'slow-hooks')).toMatch(/^An unnamed Stop hook spent /);
    expect(withEvent.find((i) => i.id === 'slow-hooks')?.explanation).toContain('an unnamed Stop hook ran 1 time');

    const withoutEvent = computeInsights(input({ hooks: [hook({ hookName: '(unnamed)', runs: 3 })] }), ctx);
    expect(titleOf(withoutEvent, 'slow-hooks')).toMatch(/^An unnamed hook spent /);
    expect(withoutEvent.find((i) => i.id === 'slow-hooks')?.explanation).toContain('ran 3 times');
  });

  it('leaves a named hook alone', () => {
    const insights = computeInsights(input({ hooks: [hook({ failures: 1 })] }), ctx);
    expect(titleOf(insights, 'slow-hooks')).toMatch(/^PostToolUse:Edit spent /);
    expect(insights.find((i) => i.id === 'slow-hooks')?.explanation).toContain('1 failure)');
  });
});

describe('long-context advice', () => {
  const long = (partial: Partial<InsightSessionRow> = {}) => session({ requestCount: 2, contextTokensTotal: 1_000_000, cost: 8, ...partial });
  const explain = (insights: ReturnType<typeof computeInsights>) => insights.find((i) => i.id === 'long-context-sessions')?.explanation ?? '';

  it('suggests /compact for Claude and a new thread for Codex', () => {
    expect(explain(computeInsights(input({ sessions: [long({ provider: 'claude' })] }), ctx))).toContain('/compact');
    const codex = explain(computeInsights(input({ sessions: [long({ provider: 'codex' })] }), ctx));
    expect(codex).toContain('new Codex thread');
    expect(codex).not.toContain('/compact');
  });

  it('labels the saving as an estimate and names the top carried tool', () => {
    const text = explain(
      computeInsights(
        input({ sessions: [long({ provider: 'claude' })], tools: [{ name: 'Read', calls: 3, genCost: 0, ingestCost: 0, carryCost: 4, topSessions: [] }] }),
        ctx,
      ),
    );
    expect(text).toMatch(/roughly \$[\d.]+ \(estimate\)/);
    expect(text).toContain('Read');
  });
});

describe('input-heavy unpriced models', () => {
  const usage = { input: 400_000, output: 2_000, cacheRead: 0, cache5m: 0, cache1h: 0, thinking: 0, webSearchRequests: 0, webFetchRequests: 0 };
  const row = (partial = {}) => ({ sessionId: 's1', title: 't', model: 'codex-auto-review', family: 'other' as const, isAgent: false, requests: 3, cost: 0, usage, unpriced: true, ...partial });

  it('fires with the ratio and never a dollar figure without an estimate', () => {
    const found = computeInsights(input({ sessionModels: [row()] }), ctx).find((i) => i.id === 'input-heavy-unpriced');
    expect(found?.title).toContain('200:1');
    expect(found?.kind).toBe('info');
    expect(found?.impactUsd).toBe(0);
    expect(`${found?.title}${found?.explanation}`).not.toMatch(/\$\d/);
  });

  it('shows a labeled estimate when one is set, and skips priced or balanced models', () => {
    const est = computeInsights(input({ sessionModels: [row({ estimatedCost: 1.5 })] }), ctx).find((i) => i.id === 'input-heavy-unpriced');
    expect(est?.impactUsd).toBe(1.5);
    expect(est?.explanation).toContain('(estimate)');
    expect(computeInsights(input({ sessionModels: [row({ unpriced: false })] }), ctx).some((i) => i.id === 'input-heavy-unpriced')).toBe(false);
    expect(computeInsights(input({ sessionModels: [row({ usage: { ...usage, output: 100_000 } })] }), ctx).some((i) => i.id === 'input-heavy-unpriced')).toBe(false);
  });
});

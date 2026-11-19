import { describe, expect, it } from 'vitest';
import { tokenCostShares } from '../../web/src/lib/token-shares.js';
import type { SessionDetail } from '../../core/types.js';

function summary(partial: Record<string, unknown> = {}): SessionDetail['summary'] {
  return {
    requestCount: 4,
    provider: 'claude',
    tokens: { input: 100, output: 100, cacheRead: 800, cache5m: 0, cache1h: 0, thinking: 0, webSearchRequests: 0, context: 900 },
    cost: { input: 0.3, output: 1.5, cacheWrite: 0, cacheRead: 0.2, webSearch: 0, total: 2 },
    ...partial,
  } as unknown as SessionDetail['summary'];
}

describe('tokenCostShares', () => {
  it('shows cache reads as many tokens but a small cost share', () => {
    const shares = tokenCostShares(summary());
    const read = shares.classes.find((c) => c.id === 'cacheRead');
    expect(read?.tokenShare).toBeCloseTo(0.8);
    expect(read?.costShare).toBeCloseTo(0.1);
    expect(shares.cacheHitRatio).toBeCloseTo(800 / 900);
    expect(shares.note).toContain('800');
  });

  it('is unavailable, not zero, without recorded usage', () => {
    const shares = tokenCostShares(summary({ usageIncomplete: true, requestCount: 0 }));
    expect(shares.available).toBe(false);
    expect(shares.classes).toEqual([]);
    expect(shares.cacheHitRatio).toBeNull();
  });

  it('has no ratio for zero context and no cost shares when unpriced', () => {
    const zero = tokenCostShares(summary({ tokens: { input: 0, output: 5, cacheRead: 0, cache5m: 0, cache1h: 0, thinking: 0, webSearchRequests: 0, context: 0 } }));
    expect(zero.cacheHitRatio).toBeNull();
    const unpriced = tokenCostShares(summary({ cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 }, unpriced: true }));
    expect(unpriced.classes.every((c) => c.costShare === null)).toBe(true);
    expect(unpriced.note).toContain('unavailable');
  });
});

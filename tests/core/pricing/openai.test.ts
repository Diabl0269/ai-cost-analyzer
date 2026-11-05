import { describe, expect, it } from 'vitest';
import { flagsOf } from '../../../core/db/price-index.js';
import { priceRequests } from '../../../core/cost/price-at-read.js';
import { request } from '../cost/builders.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { createPriceResolver, findModelPrice, resolvePrice, STANDARD_FLAGS } from '../../../core/pricing/resolve.js';
import { costOfUsage, emptyUsage, requestCost } from '../../../core/pricing/money.js';

describe('published OpenAI prices', () => {
  const pricing = defaultPricing();
  it('charges uncached input, cached input, and inclusive output once', () => {
    const price = resolvePrice('gpt-5.3-codex', STANDARD_FLAGS, pricing);
    const cost = costOfUsage({ ...emptyUsage(), input: 800, cacheRead: 200, output: 100, thinking: 60 }, price, 0);
    expect(cost.input).toBeCloseTo(800 * 1.75 / 1e6);
    expect(cost.cacheRead).toBeCloseTo(200 * 0.175 / 1e6);
    expect(cost.output).toBeCloseTo(100 * 14 / 1e6);
    expect(cost.total).toBeCloseTo(0.002835);
    expect(price.unpriced).toBe(false);
  });
  it('applies the API premium only above the inclusive input-context boundary', () => {
    const resolve = createPriceResolver(pricing);
    const short = resolve('gpt-6.1-sol', { ...STANDARD_FLAGS, contextTokens: 272_000 });
    const long = resolve('gpt-6.1-sol', { ...STANDARD_FLAGS, contextTokens: 272_001 });
    expect(short.perToken.input).toBeCloseTo(2 / 1e6);
    expect(long.perToken.input).toBeCloseTo(4 / 1e6);
    expect(long.perToken.cacheRead).toBeCloseTo(0.2 / 1e6);
    expect(long.perToken.output).toBeCloseTo(15 / 1e6);
    expect(resolve('gpt-6.1-sol', { ...STANDARD_FLAGS, contextTokens: 272_000 })).toBe(short);
    expect(resolve('gpt-6.1-sol', { ...STANDARD_FLAGS, contextTokens: 272_001 })).toBe(long);
    const cost = costOfUsage({ ...emptyUsage(), input: 72_001, cacheRead: 200_000, output: 1_000, thinking: 400 }, long, 0);
    expect(cost.total).toBeCloseTo(72_001 * 4 / 1e6 + 200_000 * 0.2 / 1e6 + 1_000 * 15 / 1e6);
    const fast = resolve('gpt-6.1-sol', { ...STANDARD_FLAGS, speed: 'fast', contextTokens: 272_001 });
    expect(fast.perToken.input).toBeCloseTo(8 / 1e6);
    expect(fast.perToken.cacheRead).toBeCloseTo(0.4 / 1e6);
    expect(fast.perToken.output).toBeCloseTo(30 / 1e6);
    expect(resolve('gpt-6-sol', STANDARD_FLAGS).perToken.cacheRead).toBeCloseTo(0.2 / 1e6);
    // Codex 5.3 has no verified context premium, so one must not be invented.
    expect(resolve('gpt-5.3-codex', { ...STANDARD_FLAGS, contextTokens: 500_000 }).perToken.input).toBeCloseTo(1.75 / 1e6);
  });

  it('includes context in what-if resolution and scales user cache-write prices', () => {
    const modified = structuredClone(pricing);
    const target = modified.models.find((model) => model.key === 'gpt-6.1-sol')!;
    target.cacheWrite5m = 2.5;
    target.cacheWrite1h = 5;
    const resolve = createPriceResolver(modified, new Map([['gpt-5', 'gpt-6.1-sol']]));
    expect(resolve('gpt-5', { ...STANDARD_FLAGS, contextTokens: 272_000 }).perToken.input).toBeCloseTo(2 / 1e6);
    const long = resolve('gpt-5', { ...STANDARD_FLAGS, contextTokens: 272_001 });
    expect(long.perToken.input).toBeCloseTo(4 / 1e6);
    expect(long.perToken.cacheWrite5m).toBeCloseTo(5 / 1e6);
    expect(long.perToken.cacheWrite1h).toBeCloseTo(10 / 1e6);
  });

  it('uses published GPT and fast prices without broad prefix matches', () => {
    expect(findModelPrice('gpt-6.1-sol', pricing)?.input).toBe(2);
    expect(resolvePrice('gpt-6.1-sol', { ...STANDARD_FLAGS, speed: 'fast' }, pricing).perToken.output).toBeCloseTo(20 / 1e6);
    for (const model of ['gpt-6.1-sol-future', 'gpt-5.3-codex-spark', 'gpt-unknown']) {
      expect(findModelPrice(model, pricing)).toBeNull();
      expect(resolvePrice(model, STANDARD_FLAGS, pricing).unpriced).toBe(true);
    }
  });
});


describe('unsupported OpenAI cache-write tariffs', () => {
  const pricing = defaultPricing();
  it('keeps a known cost floor while flagging unconfigured writes and isolating memo entries', () => {
    const resolve = createPriceResolver(pricing);
    const readOnly = resolve('gpt-6.1-sol', { ...STANDARD_FLAGS, cacheWriteTokens: 0 });
    const write = resolve('gpt-6.1-sol', { ...STANDARD_FLAGS, cacheWriteTokens: 1_000 });
    expect(readOnly.unpriced).toBe(false);
    expect(write.unpriced).toBe(true);
    expect(resolve('gpt-6.1-sol', STANDARD_FLAGS)).toBe(readOnly);
    expect(resolve('gpt-6.1-sol', { ...STANDARD_FLAGS, cacheWriteTokens: 500 })).toBe(write);
    expect(costOfUsage({ ...emptyUsage(), input: 1_000, cache5m: 1_000, output: 100 }, write, 0).total).toBeCloseTo(0.003);
    expect(resolve('claude-opus-5', { ...STANDARD_FLAGS, cacheWriteTokens: 1_000 }).unpriced).toBe(false);
  });
  it('honors explicitly configured write prices instead of guessing retention rates', () => {
    const configured = structuredClone(pricing);
    const model = configured.models.find((row) => row.key === 'gpt-6.1-sol')!;
    model.cacheWrite5m = 2.5;
    model.cacheWrite1h = 5;
    const price = resolvePrice(model.key, { ...STANDARD_FLAGS, cacheWriteTokens: 1_000 }, configured);
    expect(price.unpriced).toBe(false);
    expect(costOfUsage({ ...emptyUsage(), cache5m: 1_000 }, price, 0).total).toBeCloseTo(0.0025);
  });
  it('propagates writes from parsed usage and grouped DB usage, but not cache reads', () => {
    const u = { ...emptyUsage(), input: 1_000, cache5m: 200, cache1h: 300, output: 100 };
    const req = request({ seq: 1, model: 'gpt-6.1-sol', usage: u });
    expect(requestCost(req, pricing).resolved.unpriced).toBe(true);
    expect(priceRequests([req], pricing)[0]!.unpriced).toBe(true);
    const flags = flagsOf({ cache5m: 200, cache1h: 300, cacheAssumed: 400 });
    expect(flags.cacheWriteTokens).toBe(900);
    expect(resolvePrice(req.model, flags, pricing).unpriced).toBe(true);
    const readReq = request({ seq: 2, model: req.model, usage: { ...emptyUsage(), cacheRead: 1_000 } });
    expect(requestCost(readReq, pricing).resolved.unpriced).toBe(false);
    expect(priceRequests([readReq], pricing)[0]!.unpriced).toBe(false);
  });
});

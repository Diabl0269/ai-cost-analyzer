import { describe, expect, it } from 'vitest';
import { flagsOf } from '../../../core/db/price-index.js';
import { priceRequests } from '../../../core/cost/price-at-read.js';
import { request } from '../cost/builders.js';
import { defaultPricing, withDefaultModels } from '../../../core/pricing/defaults.js';
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
    const readOnly = resolve('gpt-5.3-codex', { ...STANDARD_FLAGS, cacheWriteTokens: 0 });
    const write = resolve('gpt-5.3-codex', { ...STANDARD_FLAGS, cacheWriteTokens: 1_000 });
    expect(readOnly.unpriced).toBe(false);
    expect(write.unpriced).toBe(true);
    expect(resolve('gpt-5.3-codex', STANDARD_FLAGS)).toBe(readOnly);
    expect(resolve('gpt-5.3-codex', { ...STANDARD_FLAGS, cacheWriteTokens: 500 })).toBe(write);
    expect(costOfUsage({ ...emptyUsage(), input: 1_000, cache5m: 1_000, output: 100 }, write, 0).total).toBeCloseTo(0.00315);
    expect(resolve('claude-opus-5', { ...STANDARD_FLAGS, cacheWriteTokens: 1_000 }).unpriced).toBe(false);
  });
  it('honors explicitly configured write prices instead of guessing retention rates', () => {
    const configured = structuredClone(pricing);
    const model = configured.models.find((row) => row.key === 'gpt-5.3-codex')!;
    model.cacheWrite5m = 2.5;
    model.cacheWrite1h = 5;
    const price = resolvePrice(model.key, { ...STANDARD_FLAGS, cacheWriteTokens: 1_000 }, configured);
    expect(price.unpriced).toBe(false);
    expect(costOfUsage({ ...emptyUsage(), cache5m: 1_000 }, price, 0).total).toBeCloseTo(0.0025);
  });
  it('propagates writes from parsed usage and grouped DB usage, but not cache reads', () => {
    const u = { ...emptyUsage(), input: 1_000, cache5m: 200, cache1h: 300, output: 100 };
    const req = request({ seq: 1, model: 'gpt-5.3-codex', usage: u });
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

describe('models added 2026-11-19', () => {
  const pricing = defaultPricing();
  const resolve = (model: string, flags = {}) => resolvePrice(model, { ...STANDARD_FLAGS, ...flags }, pricing);
  it('prices Haiku 5.5 (dotted or dashed) with the 5x tier above 100K prompt tokens', () => {
    for (const id of ['claude-haiku-5-5', 'claude-haiku-5.5']) {
      const short = resolve(id, { contextTokens: 100_000 });
      const long = resolve(id, { contextTokens: 100_001 });
      expect(short.unpriced).toBe(false);
      expect(short.perToken.input).toBeCloseTo(0.1 / 1e6);
      expect(short.perToken.output).toBeCloseTo(0.5 / 1e6);
      expect(short.perToken.cacheRead).toBeCloseTo(0.01 / 1e6);
      expect(long.perToken.input).toBeCloseTo(0.5 / 1e6);
      expect(long.perToken.output).toBeCloseTo(2.5 / 1e6);
      expect(long.perToken.cacheWrite5m).toBeCloseTo(0.625 / 1e6);
    }
  });
  it('does not price 5.5/5.2 models through the older 5 / 5.1 prefixes', () => {
    expect(resolve('claude-opus-5-5').perToken.input).toBeCloseTo(4 / 1e6);
    expect(resolve('claude-sonnet-5-5').perToken.cacheRead).toBeCloseTo(0.1 / 1e6);
    expect(resolve('claude-fable-5-2').perToken.output).toBeCloseTo(40 / 1e6);
    expect(resolve('claude-mythos-5-2').perToken.input).toBeCloseTo(8 / 1e6);
    expect(resolve('claude-opus-5').perToken.input).toBeCloseTo(5 / 1e6);
  });
  it('prices Gemini 4 Neon exactly, including its 95% implicit cache discount', () => {
    const price = resolve('gemini-4-neon');
    expect(price.unpriced).toBe(false);
    expect(price.perToken.input).toBeCloseTo(3 / 1e6);
    expect(price.perToken.output).toBeCloseTo(15 / 1e6);
    expect(price.perToken.cacheRead).toBeCloseTo(0.15 / 1e6);
    expect(price.perToken.cacheWrite5m).toBe(0);
    expect(resolve('gemini-4-neon-preview').unpriced).toBe(true);
  });
  it('prices MAI-Code-1.1-Flash exactly, without variants inheriting it', () => {
    const price = resolve('mai-code-1.1-flash');
    expect(price.unpriced).toBe(false);
    expect(price.perToken.input).toBeCloseTo(0.2 / 1e6);
    expect(price.perToken.output).toBeCloseTo(1.2 / 1e6);
    expect(price.perToken.cacheRead).toBeCloseTo(0.02 / 1e6);
    expect(resolve('mai-code-1.1-flash-preview').unpriced).toBe(true);
  });
  it('prices GPT-6 cache writes at 1.25x input', () => {
    for (const [id, input] of [['gpt-6.1-sol', 2], ['gpt-6.1-terra', 1], ['gpt-6-luna', 0.1], ['gpt-6-sol', 2], ['gpt-6-astra', 10]] as const) {
      const price = resolve(id, { cacheWriteTokens: 1_000 });
      expect(price.unpriced).toBe(false);
      expect(price.perToken.cacheWrite5m).toBeCloseTo((input * 1.25) / 1e6);
    }
  });
  it('upgrades saved zero-write GPT-6 rows and adds new models, but keeps edited rows', () => {
    const saved = structuredClone(pricing);
    saved.models = saved.models.filter((m) => !['gemini-4-neon', 'haiku-5.5', 'mai-code-1.1-flash', 'opus-5.5'].includes(m.key));
    const sol = saved.models.find((m) => m.key === 'gpt-6.1-sol')!;
    sol.cacheWrite5m = 0; sol.cacheWrite1h = 0;
    const edited = saved.models.find((m) => m.key === 'gpt-6-sol')!;
    edited.cacheWrite5m = 0; edited.cacheWrite1h = 0; edited.input = 3;
    const loaded = withDefaultModels(saved);
    expect(loaded.models.find((m) => m.key === 'gpt-6.1-sol')!.cacheWrite5m).toBe(2.5);
    expect(loaded.models.find((m) => m.key === 'gpt-6-sol')!.cacheWrite5m).toBe(0);
    for (const key of ['gemini-4-neon', 'haiku-5.5', 'mai-code-1.1-flash', 'opus-5.5']) expect(loaded.models.some((m) => m.key === key)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { defaultGoogleModels, defaultPricing, withDefaultModels } from '../../../core/pricing/defaults.js';
import { costOfUsage, emptyUsage } from '../../../core/pricing/money.js';
import { createPriceResolver, findModelPrice, resolvePrice, STANDARD_FLAGS } from '../../../core/pricing/resolve.js';

describe('published Google Gemini & Antigravity prices', () => {
  const pricing = defaultPricing();
  const resolve = (model: string, flags = {}) => resolvePrice(model, { ...STANDARD_FLAGS, ...flags }, pricing);

  it('prices the Gemini 4 series (Carbon, Argon, Neon, Hydrogen) and Antigravity thinking-tier suffixes', () => {
    for (const [id, input, output, cacheRead] of [
      ['gemini-4-carbon', 2, 10, 0.1],
      ['gemini-4-carbon-low', 2, 10, 0.1],
      ['gemini-4-carbon-medium', 2, 10, 0.1],
      ['gemini-4-carbon-high', 2, 10, 0.1],
      ['gemini-4-argon', 2, 10, 0.1],
      ['gemini-4-argon-high', 2, 10, 0.1],
      ['gemini-4-neon', 3, 15, 0.15],
      ['gemini-4-neon-xhigh', 3, 15, 0.15],
      ['gemini-4-hydrogen', 1.5, 7.5, 0.075],
      ['gemini-4-hydrogen-low', 1.5, 7.5, 0.075],
    ] as const) {
      const price = resolve(id);
      expect(price.unpriced).toBe(false);
      expect(price.perToken.input).toBeCloseTo(input / 1e6);
      expect(price.perToken.output).toBeCloseTo(output / 1e6);
      expect(price.perToken.cacheRead).toBeCloseTo(cacheRead / 1e6);
      expect(price.perToken.cacheWrite5m).toBe(0);
    }

    const cost = costOfUsage(
      { ...emptyUsage(), input: 10_000, cacheRead: 20_000, output: 1_000, thinking: 400 },
      resolve('gemini-4-carbon-medium'),
      0,
    );
    // Thinking tokens are included in output and never double-charged.
    expect(cost.total).toBeCloseTo((10_000 * 2 + 20_000 * 0.1 + 1_000 * 10) / 1e6);
  });

  it('prices Gemini 3 and 2.5 Pro long-context tiers only above 200K input context tokens', () => {
    const resolver = createPriceResolver(pricing);
    for (const [id, baseIn, baseOut, baseCache] of [
      ['gemini-3.1-pro-high', 2, 12, 0.2],
      ['gemini-3.1-pro-preview', 2, 12, 0.2],
      ['gemini-3-pro', 2, 12, 0.2],
      ['gemini-2.5-pro', 1.25, 10, 0.125],
    ] as const) {
      const short = resolver(id, { ...STANDARD_FLAGS, contextTokens: 200_000 });
      const long = resolver(id, { ...STANDARD_FLAGS, contextTokens: 200_001 });
      expect(short.unpriced).toBe(false);
      expect(short.perToken.input).toBeCloseTo(baseIn / 1e6);
      expect(short.perToken.output).toBeCloseTo(baseOut / 1e6);
      expect(short.perToken.cacheRead).toBeCloseTo(baseCache / 1e6);
      expect(long.perToken.input).toBeCloseTo((baseIn * 2) / 1e6);
      expect(long.perToken.output).toBeCloseTo((baseOut * 1.5) / 1e6);
      expect(long.perToken.cacheRead).toBeCloseTo((baseCache * 2) / 1e6);
    }
  });

  it('prices Flash and Flash-Lite models across Gemini 3.x, 2.5 and 2.0, including gateway prefixes', () => {
    for (const [id, input, output, cacheRead] of [
      ['gemini-3.8-flash-medium', 0.75, 3.75, 0.075],
      ['gemini-3.7-flash-low', 0.75, 3.75, 0.075],
      ['gemini-3.6-flash', 0.75, 3.75, 0.075],
      ['gemini-3.5-flash', 1.5, 9, 0.15],
      ['gemini-3.5-flash-lite', 0.3, 2.5, 0.03],
      ['gemini-3.1-flash-lite-preview', 0.25, 1.5, 0.025],
      ['gemini-3-flash-preview', 0.5, 3, 0.05],
      ['google/gemini-2.5-flash', 0.3, 2.5, 0.03],
      ['models/gemini-2.5-flash-lite', 0.1, 0.4, 0.01],
      ['gemini-2.0-flash', 0.1, 0.4, 0.01],
    ] as const) {
      const price = resolve(id);
      expect(price.unpriced).toBe(false);
      expect(price.perToken.input).toBeCloseTo(input / 1e6);
      expect(price.perToken.output).toBeCloseTo(output / 1e6);
      expect(price.perToken.cacheRead).toBeCloseTo(cacheRead / 1e6);
    }
  });

  it('keeps router aliases and unknown variants unpriced, while honoring custom tier overrides', () => {
    for (const unknown of ['gemini-pro-orchestrator', 'gemini-4-neon-preview', 'gemini-5-ultra']) {
      expect(findModelPrice(unknown, pricing)).toBeNull();
      expect(resolve(unknown).unpriced).toBe(true);
    }
    const custom = structuredClone(pricing);
    custom.models.push({
      ...defaultGoogleModels()[0]!,
      key: 'custom-carbon-high',
      label: 'Custom Carbon High',
      match: ['gemini-4-carbon-high'],
      exact: true,
      input: 9,
      output: 45,
      cacheRead: 0.9,
      custom: true,
    });
    expect(resolvePrice('gemini-4-carbon-high', STANDARD_FLAGS, custom).perToken.input).toBeCloseTo(9 / 1e6);
    expect(resolvePrice('gemini-4-carbon-low', STANDARD_FLAGS, custom).perToken.input).toBeCloseTo(2 / 1e6);
  });

  it('flags explicit Gemini cache writes without a configured write tariff and upgrades saved configs', () => {
    expect(resolve('gemini-4-carbon', { cacheWriteTokens: 500 }).unpriced).toBe(true);
    expect(resolve('gemini-4-carbon', { cacheWriteTokens: 0 }).unpriced).toBe(false);

    const stripped = structuredClone(pricing);
    stripped.models = stripped.models.filter((m) => !m.key.startsWith('gemini-'));
    const upgraded = withDefaultModels(stripped);
    for (const row of defaultGoogleModels()) {
      expect(upgraded.models.some((m) => m.key === row.key)).toBe(true);
    }
  });
});

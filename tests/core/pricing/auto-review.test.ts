import { describe, expect, it } from 'vitest';
import { priceRequests } from '../../../core/cost/price-at-read.js';
import { defaultPricing, withDefaultModels } from '../../../core/pricing/defaults.js';
import { costOfUsage, estimatedCostOf } from '../../../core/pricing/money.js';
import { parsePricingConfig } from '../../../core/pricing/schema.js';
import { resolvePrice, STANDARD_FLAGS } from '../../../core/pricing/resolve.js';
import { request, usage } from '../cost/builders.js';

describe('auto-review pricing requires billing evidence', () => {
  it('retains recorded usage while marking undocumented auto-review pricing as unknown', () => {
    const pricing = defaultPricing();
    const recorded = usage({ input: 1200, output: 150, cacheRead: 800, thinking: 90 });
    const rows = priceRequests([request({ seq: 1, model: 'codex-auto-review', usage: recorded })], pricing);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usage).toEqual(recorded);
    expect(rows[0]!.contextTokens).toBe(2000);
    expect(rows[0]!.unpriced).toBe(true);
    expect(rows[0]!.modelKey).toBeNull();
    // The numeric zero is an unknown-price placeholder, not evidence of a free service.
    expect(rows[0]!.cost.total).toBe(0);
  });

  it('preserves explicit user prices without silently pricing other unknown models', () => {
    const pricing = defaultPricing();
    pricing.models.push({
      key: 'codex-auto-review', label: 'Codex Auto-review', match: ['codex-auto-review'], exact: true,
      input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
      supportsUsGeo: false, charsPerToken: 4, family: 'other',
    });
    const loaded = withDefaultModels(pricing);
    expect(resolvePrice('codex-auto-review', STANDARD_FLAGS, loaded).unpriced).toBe(false);
    for (const model of ['codex-auto-review-future', 'unknown-review-model']) {
      expect(resolvePrice(model, STANDARD_FLAGS, loaded).unpriced).toBe(true);
    }
  });

  describe('estimateAs', () => {
    const withEstimate = () => {
      const pricing = defaultPricing();
      const target = pricing.models.find((m) => m.key.startsWith('gpt-'))!;
      pricing.estimateAs = { 'codex-auto-review': target.key };
      return { pricing, target };
    };

    it('prices an exact id at the target rates, flagged estimated and still unpriced', () => {
      const { pricing, target } = withEstimate();
      const resolved = resolvePrice('codex-auto-review', STANDARD_FLAGS, pricing);
      expect(resolved).toMatchObject({ unpriced: true, estimated: true, modelKey: null, estimatedAs: target.key });
      expect(resolved.perToken.input).toBeCloseTo(target.input / 1_000_000);
      const rows = priceRequests([request({ seq: 1, model: 'codex-auto-review', usage: usage({ input: 1000, output: 100 }) })], pricing);
      expect(rows[0]!.unpriced).toBe(true);
      expect(rows[0]!.estimated).toBe(true);
      expect(rows[0]!.cost.total).toBe(0);
      expect(estimatedCostOf(usage({ input: 1000, output: 100 }), resolved, 0)).toBeGreaterThan(0);
      expect(costOfUsage(usage({ input: 1000 }), resolved, 0).total).toBe(0);
    });

    it('does not let variants inherit the estimate', () => {
      const { pricing } = withEstimate();
      for (const model of ['codex-auto-review-future', 'codex-auto']) {
        const resolved = resolvePrice(model, STANDARD_FLAGS, pricing);
        expect(resolved.estimated).toBeUndefined();
        expect(resolved.unpriced).toBe(true);
      }
    });

    it('lets an explicit price row, even zero, win over the estimate', () => {
      const { pricing } = withEstimate();
      pricing.models.push({
        key: 'codex-auto-review', label: 'Codex Auto-review', match: ['codex-auto-review'], exact: true,
        input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
        supportsUsGeo: false, charsPerToken: 4, family: 'other',
      });
      const resolved = resolvePrice('codex-auto-review', STANDARD_FLAGS, pricing);
      expect(resolved.unpriced).toBe(false);
      expect(resolved.estimated).toBeUndefined();
    });

    it('rejects an estimate target that is not a configured model', () => {
      const pricing = defaultPricing();
      pricing.estimateAs = { 'codex-auto-review': 'nope' };
      expect(() => parsePricingConfig(pricing)).toThrow();
    });
  });
});

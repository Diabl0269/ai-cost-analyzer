import { describe, expect, it } from 'vitest';
import { priceRequests } from '../../../core/cost/price-at-read.js';
import { defaultPricing, withDefaultOpenAIModels } from '../../../core/pricing/defaults.js';
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
    const loaded = withDefaultOpenAIModels(pricing);
    expect(resolvePrice('codex-auto-review', STANDARD_FLAGS, loaded).unpriced).toBe(false);
    for (const model of ['codex-auto-review-future', 'unknown-review-model']) {
      expect(resolvePrice(model, STANDARD_FLAGS, loaded).unpriced).toBe(true);
    }
  });
});

import { expect, it } from 'vitest';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { findModelPrice } from '../../../core/pricing/resolve.js';

it('prices known Copilot model aliases, keeps raw custom tariffs and leaves unknown models unpriced', () => {
  const pricing = defaultPricing();
  expect(findModelPrice('claude-sonnet-4.5', pricing)?.key).toBe('sonnet-4.5');
  expect(findModelPrice('copilot/claude-sonnet-4.5', pricing)?.key).toBe('sonnet-4.5');
  expect(findModelPrice('copilot/gpt-5', pricing)?.key).toBe('gpt-5');
  expect(findModelPrice('copilot/not-a-known-model', pricing)).toBeNull();
  expect(findModelPrice('codex-auto-review', pricing)).toBeNull();
  pricing.models.unshift({ ...pricing.models[0]!, key: 'custom-copilot', match: ['copilot/claude-sonnet-4.5'], exact: true, input: 42 });
  expect(findModelPrice('copilot/claude-sonnet-4.5', pricing)?.input).toBe(42);
});

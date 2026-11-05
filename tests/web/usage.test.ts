import { describe, expect, it } from 'vitest';
import { hasNoRecordedUsage } from '../../web/src/lib/usage.js';

describe('missing token usage', () => {
  it('distinguishes unavailable usage from recorded zero and partial totals', () => {
    expect(hasNoRecordedUsage({ usageIncomplete: true, requestCount: 0 })).toBe(true);
    expect(hasNoRecordedUsage({ usageIncomplete: true, requestCount: 2 })).toBe(false);
    expect(hasNoRecordedUsage({ usageIncomplete: false, requestCount: 0 })).toBe(false);
    expect(hasNoRecordedUsage({ requestCount: 0 })).toBe(false);
    expect(hasNoRecordedUsage({ usageIncomplete: true, requestCount: 0, provider: 'copilot', tokens: { input: 25, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0, thinking: 0, webSearchRequests: 0, context: 25 } })).toBe(false);
  });
});

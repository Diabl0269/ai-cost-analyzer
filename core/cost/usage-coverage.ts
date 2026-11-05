import type { SessionSummary } from '../types.js';

/** Missing usage is unknown cost, whereas recorded zero tokens can honestly cost zero. */
export function hasNoRecordedUsage(summary: Pick<SessionSummary, 'usageIncomplete' | 'requestCount' | 'provider'> & Partial<Pick<SessionSummary, 'tokens'>>): boolean {
  const tokens = summary.tokens;
  const recorded = summary.provider === 'copilot' && tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cache5m + tokens.cache1h : 0;
  return summary.usageIncomplete === true && summary.requestCount === 0 && recorded === 0;
}

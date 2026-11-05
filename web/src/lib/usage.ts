import type { SessionSummary } from '../../../core/types.js';

/** Missing usage is unknown cost, whereas recorded zero tokens can honestly cost zero. */
export function hasNoRecordedUsage(summary: Pick<SessionSummary, 'usageIncomplete' | 'requestCount'>): boolean {
  return summary.usageIncomplete === true && summary.requestCount === 0;
}

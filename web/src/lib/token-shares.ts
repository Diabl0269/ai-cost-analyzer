import type { SessionDetail } from '../../../core/types.js';
import { hasNoRecordedUsage } from './usage.js';
import { formatMoney, formatPercent, formatTokensExact } from './format.js';

export type ShareClassId = 'output' | 'input' | 'cacheWrite' | 'cacheRead';

export interface TokenCostShare {
  id: ShareClassId;
  label: string;
  tokens: number;
  cost: number;
  /** share of all tokens; null when the session has none */
  tokenShare: number | null;
  /** share of the priced total; null when no cost is known (unpriced) */
  costShare: number | null;
}

export interface TokenCostShares {
  /** false when the transcript recorded no token usage: nothing below may be read as zero */
  available: boolean;
  classes: TokenCostShare[];
  totalTokens: number;
  /** Σ cacheRead / Σ context; null for zero context */
  cacheHitRatio: number | null;
  /** one-line explanation, or null when there is nothing to explain */
  note: string | null;
}

/**
 * Tokens against dollars by class, so a huge cache-read volume reads as the cheap line it is.
 * Missing telemetry is "unavailable" (never 0%), zero context has no hit ratio, and an unpriced
 * session has no cost shares rather than 0% ones.
 */
export function tokenCostShares(summary: SessionDetail['summary']): TokenCostShares {
  if (hasNoRecordedUsage(summary)) return { available: false, classes: [], totalTokens: 0, cacheHitRatio: null, note: null };
  const { tokens, cost } = summary;
  const raw: { id: ShareClassId; label: string; tokens: number; cost: number }[] = [
    { id: 'output', label: 'Output', tokens: tokens.output, cost: cost.output },
    { id: 'input', label: 'Fresh input', tokens: tokens.input, cost: cost.input },
    { id: 'cacheWrite', label: 'Cache write', tokens: tokens.cache5m + tokens.cache1h, cost: cost.cacheWrite },
    { id: 'cacheRead', label: 'Cache read', tokens: tokens.cacheRead, cost: cost.cacheRead },
  ];
  const totalTokens = raw.reduce((sum, row) => sum + row.tokens, 0);
  const costKnown = cost.total > 0;
  const classes = raw.map((row) => ({
    ...row,
    tokenShare: totalTokens > 0 ? row.tokens / totalTokens : null,
    costShare: costKnown ? row.cost / cost.total : null,
  }));
  const context = tokens.context;
  const cacheHitRatio = context > 0 ? tokens.cacheRead / context : null;
  const read = classes[3]!;
  const note =
    read.tokens > 0 && costKnown
      ? `Cache reads are billed at about a tenth of the input price: ${formatTokensExact(read.tokens)} tokens cost ${formatMoney(read.cost)}, ${formatPercent(read.costShare ?? 0)} of this session.`
      : read.tokens > 0
        ? `${formatTokensExact(read.tokens)} tokens were read from cache; their cost is unavailable because this session has no known price.`
        : null;
  return { available: true, classes, totalTokens, cacheHitRatio, note };
}

/**
 * Exact request cost math (SPEC §5.1).
 * Every function here is pure; nothing rounds, rounding is a formatting concern.
 */
import type {
  CostBreakdown,
  ParsedRequest,
  PricingConfig,
  ResolvedPrice,
  TokenTotals,
  TokenUsage,
} from '../types.js';
import type { PriceFlags, PriceResolver } from './resolve.js';
import { resolvePrice } from './resolve.js';

export function emptyBreakdown(): CostBreakdown {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 };
}

export function emptyTokenTotals(): TokenTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cache5m: 0,
    cache1h: 0,
    thinking: 0,
    webSearchRequests: 0,
    context: 0,
  };
}

export function emptyUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cache5m: 0,
    cache1h: 0,
    thinking: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
  };
}

/** Adds one billed unit's usage into a running total (mutates `totals`). */
export function addUsageToTotals(totals: TokenTotals, usage: TokenUsage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cache5m += usage.cache5m;
  totals.cache1h += usage.cache1h;
  totals.thinking += usage.thinking;
  totals.webSearchRequests += usage.webSearchRequests;
  totals.context += contextTokensOf(usage);
}

export function contextTokensOf(usage: TokenUsage): number {
  return usage.input + usage.cacheRead + usage.cache5m + usage.cache1h;
}

export function addBreakdown(target: CostBreakdown, add: CostBreakdown): void {
  target.input += add.input;
  target.output += add.output;
  target.cacheWrite += add.cacheWrite;
  target.cacheRead += add.cacheRead;
  target.webSearch += add.webSearch;
  target.total += add.total;
}

export function sumBreakdowns(parts: readonly CostBreakdown[]): CostBreakdown {
  const out = emptyBreakdown();
  for (const p of parts) addBreakdown(out, p);
  return out;
}

/** cost = Σ tokens·price + webSearchRequests · webSearchPer1000/1000 */
export function costOfUsage(usage: TokenUsage, price: ResolvedPrice, webSearchPer1000: number): CostBreakdown {
  const p = price.perToken;
  const input = usage.input * p.input;
  const output = usage.output * p.output;
  const cacheWrite = usage.cache5m * p.cacheWrite5m + usage.cache1h * p.cacheWrite1h;
  const cacheRead = usage.cacheRead * p.cacheRead;
  const webSearch = (usage.webSearchRequests * webSearchPer1000) / 1000;
  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    webSearch,
    total: input + output + cacheWrite + cacheRead + webSearch,
  };
}

export interface RequestCostResult {
  cost: CostBreakdown;
  /** price of the request's headline model (used for output-share attribution) */
  resolved: ResolvedPrice;
  /** present only when the request was billed as multiple iterations */
  perIteration?: CostBreakdown[];
}

function flagsOf(req: ParsedRequest): PriceFlags {
  return { speed: req.speed, inferenceGeo: req.inferenceGeo, serviceTier: req.serviceTier };
}

/**
 * Cost of one request. When `iterations` has more than one entry the request was retried at a
 * different model (fallback); each iteration bills at its own model and the totals are summed.
 */
export function requestCost(
  req: ParsedRequest,
  pricing: PricingConfig,
  resolver?: PriceResolver,
): RequestCostResult {
  const flags = { ...flagsOf(req), contextTokens: req.contextTokens };
  const resolve = resolver ?? ((model: string, f: PriceFlags) => resolvePrice(model, f, pricing));
  const resolved = resolve(req.model, flags);
  const iterations = req.iterations;
  if (iterations && iterations.length > 1) {
    const perIteration = iterations.map((it) =>
      costOfUsage(it.usage, resolve(it.model || req.model, { ...flags, contextTokens: contextTokensOf(it.usage) }), pricing.webSearchPer1000),
    );
    return { cost: sumBreakdowns(perIteration), resolved, perIteration };
  }
  return { cost: costOfUsage(req.usage, resolved, pricing.webSearchPer1000), resolved };
}

/** Total usage actually billed for a request (sum of iterations when they exist). */
export function billedUsage(req: ParsedRequest): TokenUsage {
  const iterations = req.iterations;
  if (!iterations || iterations.length <= 1) return req.usage;
  const out = emptyUsage();
  for (const it of iterations) {
    out.input += it.usage.input;
    out.output += it.usage.output;
    out.cacheRead += it.usage.cacheRead;
    out.cache5m += it.usage.cache5m;
    out.cache1h += it.usage.cache1h;
    out.thinking += it.usage.thinking;
    out.webSearchRequests += it.usage.webSearchRequests;
    out.webFetchRequests += it.usage.webFetchRequests;
  }
  return out;
}

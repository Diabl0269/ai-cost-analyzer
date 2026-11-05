/**
 * Turns stored, price-independent facts into money (SPEC §5.3).
 *
 * The index holds prefix sums of `avgContextPrice` over a transcript's requests, so pricing one
 * attributed item is O(log n) for the seq lookup and O(1) for the carry sum, no matter how many
 * requests carried it.
 */
import type {
  AttributedCost,
  Attribution,
  ContextEstMethod,
  ContextItemCost,
  ContextItemKind,
  CostBreakdown,
  EstMethod,
  ParsedRequest,
  PricingConfig,
  RequestCost,
  ResolvedPrice,
  ToolCallCost,
  ToolResultShape,
  TokenUsage,
} from '../types.js';
import { contextTokensOf, costOfUsage } from '../pricing/money.js';
import { createPriceResolver, type PriceResolver } from '../pricing/resolve.js';

/** Everything pricing needs about one request, from either a ParsedRequest or a DB row. */
export interface PricedRequestInput {
  seq: number;
  usage: TokenUsage;
  contextTokens: number;
  resolved: ResolvedPrice;
}

/** Blended USD/token for content that is newly written into the context at this request. */
export function newTokenPrice(req: { usage: TokenUsage }, resolved: ResolvedPrice): number {
  const { input, cache5m, cache1h } = req.usage;
  const denominator = input + cache5m + cache1h;
  if (denominator <= 0) return resolved.perToken.input;
  const p = resolved.perToken;
  return (input * p.input + cache5m * p.cacheWrite5m + cache1h * p.cacheWrite1h) / denominator;
}

/** Blended USD/token for content that is merely re-sent as part of this request's context. */
export function avgContextPrice(
  req: { usage: TokenUsage; contextTokens?: number },
  resolved: ResolvedPrice,
): number {
  const context = req.contextTokens ?? contextTokensOf(req.usage);
  if (context <= 0) return 0;
  const { input, cache5m, cache1h, cacheRead } = req.usage;
  const p = resolved.perToken;
  return (
    (input * p.input + cache5m * p.cacheWrite5m + cache1h * p.cacheWrite1h + cacheRead * p.cacheRead) /
    context
  );
}

/** Per-transcript prefix sums; build once per transcript, then price every item off it. */
export interface RequestPriceIndex {
  /** ascending request seqs */
  seqs: number[];
  newTokenPrice: Float64Array;
  outputPerToken: Float64Array;
  /** avgContextPrefix[j] = Σ avgContextPrice(R_k) for k < j */
  avgContextPrefix: Float64Array;
}

export function buildPriceIndex(requests: readonly PricedRequestInput[]): RequestPriceIndex {
  const sorted = [...requests].sort((a, b) => a.seq - b.seq);
  const n = sorted.length;
  const index: RequestPriceIndex = {
    seqs: new Array<number>(n),
    newTokenPrice: new Float64Array(n),
    outputPerToken: new Float64Array(n),
    avgContextPrefix: new Float64Array(n + 1),
  };
  for (let i = 0; i < n; i += 1) {
    const req = sorted[i];
    if (!req) continue;
    index.seqs[i] = req.seq;
    index.newTokenPrice[i] = newTokenPrice(req, req.resolved);
    index.outputPerToken[i] = req.resolved.perToken.output;
    index.avgContextPrefix[i + 1] = (index.avgContextPrefix[i] ?? 0) + avgContextPrice(req, req.resolved);
  }
  return index;
}

export const EMPTY_PRICE_INDEX: RequestPriceIndex = {
  seqs: [],
  newTokenPrice: new Float64Array(0),
  outputPerToken: new Float64Array(0),
  avgContextPrefix: new Float64Array(1),
};

/** Position of `seq` in the index, or -1. */
function positionOf(index: RequestPriceIndex, seq: number): number {
  const seqs = index.seqs;
  let lo = 0;
  let hi = seqs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = seqs[mid] ?? 0;
    if (value === seq) return mid;
    if (value < seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Last position whose seq is ≤ `seq` (used for the carry range end). */
function positionAtOrBefore(index: RequestPriceIndex, seq: number): number {
  const seqs = index.seqs;
  let lo = 0;
  let hi = seqs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((seqs[mid] ?? 0) <= seq) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** The attribution facts needed to price one item. */
export interface AttributedFacts {
  tokens: number;
  estMethod: EstMethod;
  ingestRequestSeq: number | null;
  lastCarrySeq: number | null;
}

/** The money half of {@link priceItem}, without the estimation label — shared with context items. */
export interface PricedRange {
  ingestCost: number;
  carryCost: number;
  carryRequests: number;
}

/** ingestCost = tokens · newTokenPrice(R_ingest); carryCost = tokens · Σ avgContextPrice over (ingest, lastCarry]. */
export function priceRange(
  tokens: number,
  ingestRequestSeq: number | null,
  lastCarrySeq: number | null,
  index: RequestPriceIndex,
): PricedRange {
  const base: PricedRange = { ingestCost: 0, carryCost: 0, carryRequests: 0 };
  if (ingestRequestSeq === null) return base;
  const ingestPos = positionOf(index, ingestRequestSeq);
  if (ingestPos < 0) return base;
  base.ingestCost = tokens * (index.newTokenPrice[ingestPos] ?? 0);
  if (lastCarrySeq === null) return base;
  const lastPos = positionAtOrBefore(index, lastCarrySeq);
  if (lastPos <= ingestPos) return base;
  const from = index.avgContextPrefix[ingestPos + 1] ?? 0;
  const to = index.avgContextPrefix[lastPos + 1] ?? 0;
  base.carryCost = tokens * (to - from);
  base.carryRequests = lastPos - ingestPos;
  return base;
}

/** ingestCost = tokens · newTokenPrice(R_ingest); carryCost = tokens · Σ avgContextPrice over (ingest, lastCarry]. */
export function priceItem(item: AttributedFacts, index: RequestPriceIndex): AttributedCost {
  const priced = priceRange(item.tokens, item.ingestRequestSeq, item.lastCarrySeq, index);
  return { tokens: item.tokens, estMethod: item.estMethod, ...priced };
}

/**
 * Row shape for the whole-context items (`assistant_history`, `baseline`,
 * `post_compaction_floor`). They are priced exactly like tool results and injections; they carry
 * no generation cost of their own, so ingest + carry is the whole story.
 */
export interface ContextItemCostRow {
  /** present when rows come from several sessions at once (analytics) */
  sessionId?: string;
  agentId: string | null;
  seq: number;
  turnIndex: number;
  kind: ContextItemKind;
  tokens: number;
  estMethod: ContextEstMethod;
  ingestRequestSeq: number | null;
  lastCarrySeq: number | null;
}

export function contextItemCosts(
  rows: readonly ContextItemCostRow[],
  indexFor: (row: ContextItemCostRow) => RequestPriceIndex,
): ContextItemCost[] {
  return rows.map((row) => ({
    seq: row.seq,
    agentId: row.agentId,
    turnIndex: row.turnIndex,
    kind: row.kind,
    tokens: row.tokens,
    estMethod: row.estMethod,
    ...priceRange(row.tokens, row.ingestRequestSeq, row.lastCarrySeq, indexFor(row)),
  }));
}

/** USD/token of the output of the request at `seq` (0 when the request is unknown). */
export function outputPriceAt(index: RequestPriceIndex, seq: number): number {
  const pos = positionOf(index, seq);
  return pos < 0 ? 0 : (index.outputPerToken[pos] ?? 0);
}

/** Row shape shared by the indexer (from ParsedToolCall) and the store (from SQL). */
export interface ToolCallCostRow extends AttributedFacts {
  toolUseId: string;
  /** present when rows come from several sessions at once (analytics) */
  sessionId?: string;
  agentId: string | null;
  name: string;
  mcpServer?: string;
  requestSeq: number;
  resultSeq?: number;
  turnIndex: number;
  ts: string;
  inputSummary: string;
  inputChars: number;
  resultChars: number;
  resultShape: ToolResultShape;
  isError: boolean;
  /** the tool_use block's share of the emitting request's output tokens */
  genTokens: number;
  childAgentId?: string;
  childRunId?: string;
  childModel?: string;
  childDescription?: string;
}

/**
 * `ownCost = genCost + ingestCost + carryCost`. `childCost` stays null here; the store fills it
 * from the linked agent / workflow run totals so child spend is never folded into the parent.
 */
export function toolCallCosts(
  rows: readonly ToolCallCostRow[],
  indexFor: (row: ToolCallCostRow) => RequestPriceIndex,
): ToolCallCost[] {
  return rows.map((row) => {
    const index = indexFor(row);
    const result = priceItem(row, index);
    const genCost = row.genTokens * outputPriceAt(index, row.requestSeq);
    const cost: ToolCallCost = {
      toolUseId: row.toolUseId,
      agentId: row.agentId,
      name: row.name,
      requestSeq: row.requestSeq,
      turnIndex: row.turnIndex,
      ts: row.ts,
      inputSummary: row.inputSummary,
      inputChars: row.inputChars,
      resultChars: row.resultChars,
      resultShape: row.resultShape,
      isError: row.isError,
      genTokens: row.genTokens,
      genCost,
      result,
      ownCost: genCost + result.ingestCost + result.carryCost,
      childCost: null,
    };
    if (row.mcpServer !== undefined) cost.mcpServer = row.mcpServer;
    if (row.resultSeq !== undefined) cost.resultSeq = row.resultSeq;
    if (row.childAgentId !== undefined) cost.childAgentId = row.childAgentId;
    if (row.childRunId !== undefined) cost.childRunId = row.childRunId;
    if (row.childModel !== undefined) cost.childModel = row.childModel;
    if (row.childDescription !== undefined) cost.childDescription = row.childDescription;
    return cost;
  });
}

export interface RequestCostRow extends PricedRequestInput {
  turnIndex: number;
  ts: string;
  model: string;
  speed: RequestCost['speed'];
  stopReason?: string;
  isFallback: boolean;
  attribution: Attribution;
  toolNames: string[];
  cost: CostBreakdown;
}

/** Context above this with a zero cache read means the whole prompt was re-written (SPEC §5.3). */
export const COLD_CACHE_CONTEXT_TOKENS = 20_000;

export function toRequestCost(row: RequestCostRow): RequestCost {
  const context = row.contextTokens;
  const out: RequestCost = {
    seq: row.seq,
    turnIndex: row.turnIndex,
    ts: row.ts,
    model: row.model,
    modelKey: row.resolved.modelKey,
    family: row.resolved.family,
    usage: row.usage,
    contextTokens: context,
    cost: row.cost,
    cacheHitRatio: context > 0 ? row.usage.cacheRead / context : 0,
    coldCache: context > COLD_CACHE_CONTEXT_TOKENS && row.usage.cacheRead === 0,
    speed: row.speed,
    isFallback: row.isFallback,
    unpriced: row.resolved.unpriced,
    attribution: row.attribution,
    toolNames: row.toolNames,
  };
  if (row.stopReason !== undefined) out.stopReason = row.stopReason;
  return out;
}

/** Prices a parsed transcript's requests. Synthetic messages are excluded (SPEC §3.3). */
export function priceRequests(
  requests: readonly ParsedRequest[],
  pricing: PricingConfig,
  resolver?: PriceResolver,
): RequestCost[] {
  const resolve = resolver ?? createPriceResolver(pricing);
  const out: RequestCost[] = [];
  for (const req of requests) {
    if (req.isSynthetic) continue;
    const flags = { speed: req.speed, inferenceGeo: req.inferenceGeo, serviceTier: req.serviceTier, contextTokens: req.contextTokens, cacheWriteTokens: req.usage.cache5m + req.usage.cache1h };
    let resolved = resolve(req.model, flags);
    let cost: CostBreakdown;
    if (req.iterations && req.iterations.length > 1) {
      cost = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 };
      for (const it of req.iterations) {
        const price = resolve(it.model || req.model, {
          ...flags, contextTokens: contextTokensOf(it.usage),
          cacheWriteTokens: it.usage.cache5m + it.usage.cache1h,
        });
        if (price.unpriced) resolved = { ...resolved, unpriced: true };
        const itCost = costOfUsage(it.usage, price, pricing.webSearchPer1000);
        cost.input += itCost.input;
        cost.output += itCost.output;
        cost.cacheWrite += itCost.cacheWrite;
        cost.cacheRead += itCost.cacheRead;
        cost.webSearch += itCost.webSearch;
        cost.total += itCost.total;
      }
    } else {
      cost = costOfUsage(req.usage, resolved, pricing.webSearchPer1000);
    }
    const row: RequestCostRow = {
      seq: req.seq,
      usage: req.usage,
      contextTokens: req.contextTokens,
      resolved,
      turnIndex: req.turnIndex,
      ts: req.ts,
      model: req.model,
      speed: req.speed,
      isFallback: req.isFallback,
      attribution: req.attribution,
      toolNames: req.blocks
        .filter((b) => b.type === 'tool_use' && b.toolName)
        .map((b) => b.toolName ?? ''),
      cost,
    };
    if (req.stopReason !== undefined) row.stopReason = req.stopReason;
    out.push(toRequestCost(row));
  }
  return out;
}

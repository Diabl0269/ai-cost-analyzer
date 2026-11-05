/**
 * Session detail assembly: requests, turns, tool calls with child spend, hooks, compactions and
 * the agent / workflow tree. Child (subagent) spend is reported alongside a tool call but never
 * added into the parent transcript's own totals (SPEC §5.3).
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentNode,
  CategoryShare,
  CompactionRow,
  ContextItemCost,
  CostBreakdown,
  HookRecordKind,
  HookRunRow,
  InjectionCost,
  PricingConfig,
  RequestCost,
  ToolCallCost,
  TokenTotals,
  TokenUsage,
  TurnSummary,
  WorkflowRunNode,
} from '../types.js';
import type { PriceResolver } from '../pricing/resolve.js';
import {
  addBreakdown,
  addUsageToTotals,
  costOfUsage,
  emptyBreakdown,
  emptyTokenTotals,
  emptyUsage,
} from '../pricing/money.js';
import { toRequestCost, type RequestCostRow } from '../cost/price-at-read.js';
import {
  CONTEXT_ITEM_COLUMNS,
  INJECTION_COLUMNS,
  TOOL_CALL_COLUMNS,
  contextItemCostsFrom,
  injectionCostsFrom,
  toolCallCostsFrom,
} from './attributed.js';
import { flagsOf, usageOf, type PriceIndexes } from './price-index.js';
import { bool, jsonColumn, nullableNum, num, optStr, str, type Row } from './rows.js';
import { MAIN_AGENT } from './write-session.js';

const REQUEST_DETAIL_COLUMNS = `sessionId, agentId, seq, iterIndex, turnIndex, ts, model, speed, serviceTier,
  inferenceGeo, input, output, cacheRead, cache5m, cache1h, cacheAssumed, thinking, webSearchRequests,
  webFetchRequests, contextTokens, stopReason, isFallback, skill, plugin, mcpServer, mcpTool, toolNamesJson`;

function addUsage(target: TokenUsage, add: TokenUsage): void {
  target.input += add.input;
  target.output += add.output;
  target.cacheRead += add.cacheRead;
  target.cache5m += add.cache5m;
  target.cache1h += add.cache1h;
  target.thinking += add.thinking;
  target.webSearchRequests += add.webSearchRequests;
  target.webFetchRequests += add.webFetchRequests;
}

/** Requests of one transcript, with the extra billed iterations folded into the same seq. */
export function loadRequestCosts(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  resolve: PriceResolver,
  pricing: PricingConfig,
): RequestCost[] {
  const rows = db
    .prepare(
      `SELECT ${REQUEST_DETAIL_COLUMNS} FROM requests
       WHERE sessionId = ? AND agentId = ? ORDER BY seq, iterIndex`,
    )
    .all(sessionId, agentId) as Row[];
  const bySeq = new Map<number, { row: RequestCostRow; usage: TokenUsage }>();
  for (const row of rows) {
    const seq = num(row, 'seq');
    const usage = usageOf(row, pricing);
    const resolved = resolve(str(row, 'model'), flagsOf(row));
    const cost = costOfUsage(usage, resolved, pricing.webSearchPer1000);
    const existing = bySeq.get(seq);
    if (existing) {
      addBreakdown(existing.row.cost, cost);
      addUsage(existing.usage, usage);
      existing.row.usage = existing.usage;
      continue;
    }
    const totals = emptyUsage();
    addUsage(totals, usage);
    const attribution = {
      ...(optStr(row, 'skill') ? { skill: str(row, 'skill') } : {}),
      ...(optStr(row, 'plugin') ? { plugin: str(row, 'plugin') } : {}),
      ...(optStr(row, 'mcpServer') ? { mcpServer: str(row, 'mcpServer') } : {}),
      ...(optStr(row, 'mcpTool') ? { mcpTool: str(row, 'mcpTool') } : {}),
    };
    const costRow: RequestCostRow = {
      seq,
      usage: totals,
      contextTokens: num(row, 'contextTokens'),
      resolved,
      turnIndex: num(row, 'turnIndex'),
      ts: str(row, 'ts'),
      model: str(row, 'model'),
      speed: flagsOf(row).speed,
      isFallback: bool(row, 'isFallback'),
      attribution,
      toolNames: jsonColumn<string[]>(row, 'toolNamesJson', []),
      cost,
    };
    const stopReason = optStr(row, 'stopReason');
    if (stopReason) costRow.stopReason = stopReason;
    bySeq.set(seq, { row: costRow, usage: totals });
  }
  return [...bySeq.values()].map((entry) => toRequestCost(entry.row));
}

export interface AgentTotals {
  tokens: TokenTotals;
  cost: CostBreakdown;
  models: string[];
  requests: number;
}

export function loadAgentTotals(
  db: DatabaseSync,
  sessionId: string,
  resolve: PriceResolver,
  pricing: PricingConfig,
): Map<string, AgentTotals> {
  const rows = db
    .prepare(
      `SELECT agentId, model, speed, serviceTier, inferenceGeo,
        SUM(input) AS input, SUM(output) AS output, SUM(cacheRead) AS cacheRead, SUM(cache5m) AS cache5m,
        SUM(cache1h) AS cache1h, SUM(cacheAssumed) AS cacheAssumed, SUM(thinking) AS thinking,
        SUM(webSearchRequests) AS webSearchRequests,
        SUM(webFetchRequests) AS webFetchRequests, contextTokens AS pricingContextTokens, SUM(contextTokens) AS contextTokens,
        SUM(CASE WHEN iterIndex = 0 THEN 1 ELSE 0 END) AS requests
       FROM requests WHERE sessionId = ?
       GROUP BY agentId, model, speed, serviceTier, inferenceGeo, contextTokens`,
    )
    .all(sessionId) as Row[];
  const out = new Map<string, AgentTotals>();
  for (const row of rows) {
    const agentId = str(row, 'agentId');
    const usage = usageOf(row, pricing);
    const resolved = resolve(str(row, 'model'), flagsOf(row));
    const totals = out.get(agentId) ?? {
      tokens: emptyTokenTotals(),
      cost: emptyBreakdown(),
      models: [],
      requests: 0,
    };
    addUsageToTotals(totals.tokens, usage);
    addBreakdown(totals.cost, costOfUsage(usage, resolved, pricing.webSearchPer1000));
    totals.requests += num(row, 'requests');
    if (!totals.models.includes(str(row, 'model'))) totals.models.push(str(row, 'model'));
    out.set(agentId, totals);
  }
  return out;
}

export interface AgentTree {
  roots: AgentNode[];
  workflowRuns: WorkflowRunNode[];
  /** agentId → cost of that agent and everything it spawned */
  subtreeCost: Map<string, number>;
  runCost: Map<string, number>;
}

export function buildAgentTree(
  db: DatabaseSync,
  sessionId: string,
  totals: ReadonlyMap<string, AgentTotals>,
): AgentTree {
  const rows = db.prepare('SELECT * FROM agents WHERE sessionId = ? ORDER BY spawnDepth, agentId').all(
    sessionId,
  ) as Row[];
  const nodes = new Map<string, AgentNode>();
  for (const row of rows) {
    const agentId = str(row, 'agentId');
    const total = totals.get(agentId);
    const node: AgentNode = {
      agentId,
      models: total?.models ?? [],
      spawnDepth: num(row, 'spawnDepth'),
      requestCount: num(row, 'requestCount'),
      toolCallCount: num(row, 'toolCallCount'),
      tokens: total?.tokens ?? emptyTokenTotals(),
      cost: total?.cost ?? emptyBreakdown(),
      children: [],
    };
    const runId = optStr(row, 'runId');
    if (runId) node.runId = runId;
    const parentAgentId = optStr(row, 'parentAgentId');
    if (parentAgentId) node.parentAgentId = parentAgentId;
    const parentToolUseId = optStr(row, 'parentToolUseId');
    if (parentToolUseId) node.parentToolUseId = parentToolUseId;
    const agentType = optStr(row, 'agentType');
    if (agentType) node.agentType = agentType;
    const description = optStr(row, 'description');
    if (description) node.description = description;
    const requestedModel = optStr(row, 'requestedModel');
    if (requestedModel) node.requestedModel = requestedModel;
    const startedAt = optStr(row, 'startedAt');
    if (startedAt) node.startedAt = startedAt;
    const endedAt = optStr(row, 'endedAt');
    if (endedAt) node.endedAt = endedAt;
    nodes.set(agentId, node);
  }

  const roots: AgentNode[] = [];
  const runRoots = new Map<string, AgentNode[]>();
  for (const node of nodes.values()) {
    const parent = node.parentAgentId ? nodes.get(node.parentAgentId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
      continue;
    }
    if (node.runId) {
      const list = runRoots.get(node.runId) ?? [];
      list.push(node);
      runRoots.set(node.runId, list);
    } else {
      roots.push(node);
    }
  }

  const subtreeCost = new Map<string, number>();
  const costOf = (node: AgentNode): number => {
    const cached = subtreeCost.get(node.agentId);
    if (cached !== undefined) return cached;
    subtreeCost.set(node.agentId, node.cost.total);
    const total = node.children.reduce((sum, child) => sum + costOf(child), node.cost.total);
    subtreeCost.set(node.agentId, total);
    return total;
  };
  for (const node of nodes.values()) costOf(node);

  const runRows = db.prepare('SELECT * FROM workflow_runs WHERE sessionId = ?').all(sessionId) as Row[];
  const runCost = new Map<string, number>();
  const workflowRuns: WorkflowRunNode[] = runRows.map((row) => {
    const runId = str(row, 'runId');
    const agents = runRoots.get(runId) ?? [];
    const cost = emptyBreakdown();
    for (const agent of agents) accumulateSubtree(agent, cost);
    runCost.set(runId, cost.total);
    const node: WorkflowRunNode = {
      runId,
      agentCount: num(row, 'agentCount'),
      cost,
      journal: {
        started: num(row, 'journalStarted'),
        result: num(row, 'journalResult'),
        failed: num(row, 'journalFailed'),
      },
      agents,
    };
    const toolUseId = optStr(row, 'toolUseId');
    if (toolUseId) node.toolUseId = toolUseId;
    return node;
  });

  return { roots, workflowRuns, subtreeCost, runCost };
}

function accumulateSubtree(node: AgentNode, into: CostBreakdown): void {
  addBreakdown(into, node.cost);
  for (const child of node.children) accumulateSubtree(child, into);
}

export function loadToolCalls(
  db: DatabaseSync,
  sessionId: string,
  indexes: PriceIndexes,
  tree: AgentTree,
): ToolCallCost[] {
  const rows = db
    .prepare(`SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls WHERE sessionId = ? ORDER BY agentId, requestSeq`)
    .all(sessionId) as Row[];
  const calls = toolCallCostsFrom(rows, indexes);
  for (const call of calls) {
    if (call.childAgentId) call.childCost = tree.subtreeCost.get(call.childAgentId) ?? 0;
    else if (call.childRunId) call.childCost = tree.runCost.get(call.childRunId) ?? 0;
  }
  return calls;
}

export function loadInjections(db: DatabaseSync, sessionId: string, indexes: PriceIndexes): InjectionCost[] {
  const rows = db
    .prepare(`SELECT ${INJECTION_COLUMNS} FROM injections WHERE sessionId = ? ORDER BY agentId, seq`)
    .all(sessionId) as Row[];
  return injectionCostsFrom(rows, indexes);
}

export function loadContextItems(
  db: DatabaseSync,
  sessionId: string,
  indexes: PriceIndexes,
): ContextItemCost[] {
  const rows = db
    .prepare(`SELECT ${CONTEXT_ITEM_COLUMNS} FROM context_items WHERE sessionId = ? ORDER BY agentId, seq`)
    .all(sessionId) as Row[];
  return contextItemCostsFrom(rows, indexes);
}

const HOOK_INJECTION_KINDS = new Set(['hook_context', 'hook_blocking', 'hook_stdout']);

export function loadHookRuns(
  db: DatabaseSync,
  sessionId: string,
  injections: readonly InjectionCost[],
): HookRunRow[] {
  const costBySeq = new Map<string, number>();
  for (const injection of injections) {
    if (!HOOK_INJECTION_KINDS.has(injection.kind)) continue;
    const key = `${injection.agentId ?? ''} ${injection.seq}`;
    costBySeq.set(key, (costBySeq.get(key) ?? 0) + injection.cost.ingestCost + injection.cost.carryCost);
  }
  const rows = db
    .prepare('SELECT * FROM hook_runs WHERE sessionId = ? ORDER BY agentId, seq')
    .all(sessionId) as Row[];
  return rows.map((row) => {
    const agentId = str(row, 'agentId');
    const out: HookRunRow = {
      seq: num(row, 'seq'),
      agentId: agentId === MAIN_AGENT ? null : agentId,
      turnIndex: num(row, 'turnIndex'),
      kind: str(row, 'kind') as HookRecordKind,
      injectedChars: num(row, 'injectedChars'),
      estCost: costBySeq.get(`${agentId} ${num(row, 'seq')}`) ?? 0,
    };
    const ts = optStr(row, 'ts');
    if (ts) out.ts = ts;
    const hookName = optStr(row, 'hookName');
    if (hookName) out.hookName = hookName;
    const hookEvent = optStr(row, 'hookEvent');
    if (hookEvent) out.hookEvent = hookEvent;
    const command = optStr(row, 'command');
    if (command) out.command = command;
    const durationMs = nullableNum(row, 'durationMs');
    if (durationMs !== null) out.durationMs = durationMs;
    const exitCode = nullableNum(row, 'exitCode');
    if (exitCode !== null) out.exitCode = exitCode;
    if (bool(row, 'timedOut')) out.timedOut = true;
    return out;
  });
}

/** rewarmCost = the cache-write cost of the first request after the boundary (SPEC §5.3). */
export function loadCompactions(db: DatabaseSync, sessionId: string, resolve: PriceResolver): CompactionRow[] {
  const rows = db
    .prepare('SELECT * FROM compactions WHERE sessionId = ? ORDER BY agentId, seq')
    .all(sessionId) as Row[];
  const next = db.prepare(
    `SELECT model, speed, serviceTier, inferenceGeo, cache5m, cache1h, cacheAssumed, input, output,
       cacheRead, thinking, webSearchRequests, webFetchRequests
     FROM requests WHERE sessionId = ? AND agentId = ? AND seq > ? AND iterIndex = 0
     ORDER BY seq LIMIT 1`,
  );
  return rows.map((row) => {
    const agentId = str(row, 'agentId');
    const seq = num(row, 'seq');
    const after = next.get(sessionId, agentId, seq) as Row | undefined;
    let rewarmCost = 0;
    if (after) {
      const resolved = resolve(str(after, 'model'), flagsOf(after));
      rewarmCost =
        num(after, 'cache5m') * resolved.perToken.cacheWrite5m +
        num(after, 'cache1h') * resolved.perToken.cacheWrite1h;
    }
    const out: CompactionRow = {
      seq,
      agentId: agentId === MAIN_AGENT ? null : agentId,
      turnIndex: num(row, 'turnIndex'),
      rewarmCost,
    };
    const ts = optStr(row, 'ts');
    if (ts) out.ts = ts;
    const trigger = optStr(row, 'trigger');
    if (trigger) out.trigger = trigger;
    const preTokens = nullableNum(row, 'preTokens');
    if (preTokens !== null) out.preTokens = preTokens;
    const postTokens = nullableNum(row, 'postTokens');
    if (postTokens !== null) out.postTokens = postTokens;
    const durationMs = nullableNum(row, 'durationMs');
    if (durationMs !== null) out.durationMs = durationMs;
    return out;
  });
}

export function buildTurns(
  db: DatabaseSync,
  sessionId: string,
  requests: readonly RequestCost[],
  toolCalls: readonly ToolCallCost[],
  turnDurationsMs: readonly number[],
): TurnSummary[] {
  const previews = db
    .prepare(
      `SELECT turnIndex, MIN(seq) AS seq, preview FROM messages
       WHERE sessionId = ? AND agentId = '' AND kind = 'prompt' GROUP BY turnIndex`,
    )
    .all(sessionId) as Row[];
  const previewByTurn = new Map<number, { seq: number; preview: string }>();
  for (const row of previews) {
    previewByTurn.set(num(row, 'turnIndex'), { seq: num(row, 'seq'), preview: str(row, 'preview') });
  }
  const turns = new Map<number, TurnSummary>();
  for (const request of requests) {
    const existing = turns.get(request.turnIndex);
    if (existing) {
      existing.requestCount += 1;
      existing.cost += request.cost.total;
      existing.startSeq = Math.min(existing.startSeq, request.seq);
      continue;
    }
    const preview = previewByTurn.get(request.turnIndex);
    const summary: TurnSummary = {
      turnIndex: request.turnIndex,
      startSeq: preview?.seq ?? request.seq,
      ts: request.ts,
      promptPreview: preview?.preview ?? '',
      requestCount: 1,
      toolCallCount: 0,
      cost: request.cost.total,
    };
    const duration = turnDurationsMs[request.turnIndex];
    if (duration !== undefined) summary.durationMs = duration;
    turns.set(request.turnIndex, summary);
  }
  for (const call of toolCalls) {
    if (call.agentId !== null) continue;
    const turn = turns.get(call.turnIndex);
    if (turn) turn.toolCallCount += 1;
  }
  return [...turns.values()].sort((a, b) => a.turnIndex - b.turnIndex);
}

const HARNESS_KINDS: Record<string, keyof CategoryShare['estimated']> = {
  user_prompt: 'userPrompts',
  hook_context: 'hooks',
  hook_blocking: 'hooks',
  hook_stdout: 'hooks',
  attachment: 'harness',
  compact_summary: 'compactSummaries',
  system_prompt: 'systemPrompt',
  other: 'other',
};

/**
 * The estimated split of what filled the context. Every context token is owned by exactly one
 * bucket: a gap item (tool result, prompt, hook, attachment, summary), the assistant's own re-sent
 * replies (`assistantHistory`) or the baseline floor (`baseline`) — see docs/METHODOLOGY.md §3.
 * `assistantOutput` is the exact generation cost and is *not* part of the context split.
 */
export function buildCategories(
  exact: CostBreakdown,
  toolCalls: readonly ToolCallCost[],
  injections: readonly InjectionCost[],
  contextItems: readonly ContextItemCost[] = [],
): CategoryShare {
  const estimated: CategoryShare['estimated'] = {
    assistantOutput: exact.output,
    userPrompts: 0,
    toolResultsByTool: [],
    hooks: 0,
    harness: 0,
    compactSummaries: 0,
    systemPrompt: 0,
    other: 0,
    assistantHistory: 0,
    baseline: 0,
  };
  for (const item of contextItems) {
    const value = item.ingestCost + item.carryCost;
    if (item.kind === 'assistant_history') estimated.assistantHistory = (estimated.assistantHistory ?? 0) + value;
    else estimated.baseline = (estimated.baseline ?? 0) + value;
  }
  for (const injection of injections) {
    const bucket = HARNESS_KINDS[injection.kind] ?? 'other';
    if (bucket === 'toolResultsByTool') continue;
    const value = injection.cost.ingestCost + injection.cost.carryCost;
    const current = estimated[bucket];
    if (typeof current === 'number') estimated[bucket] = current + value;
  }
  const byTool = new Map<string, { name: string; cost: number; calls: number }>();
  for (const call of toolCalls) {
    const entry = byTool.get(call.name) ?? { name: call.name, cost: 0, calls: 0 };
    entry.cost += call.result.ingestCost + call.result.carryCost;
    entry.calls += 1;
    byTool.set(call.name, entry);
  }
  estimated.toolResultsByTool = [...byTool.values()].sort((a, b) => b.cost - a.cost);
  return { exact, estimated };
}

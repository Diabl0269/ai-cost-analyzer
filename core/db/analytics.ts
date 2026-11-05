/**
 * Range analytics (SPEC §7.2 `/api/analytics/*`).
 *
 * Shape of every query here: aggregate tokens in SQL grouped by model and billing flags, then
 * price each group once in JS. That keeps an overview over 10k requests to a handful of grouped
 * scans rather than 10k price lookups.
 *
 * Range semantics: an item counts when its own local date falls inside the range; a session counts
 * when it has at least one request in the range.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  AttributionAnalyticsResponse,
  CategoryShare,
  CostBreakdown,
  DailyPoint,
  HarnessAnalyticsRow,
  HookAnalyticsRow,
  HooksAnalyticsResponse,
  ModelCostRow,
  ModelsAnalyticsResponse,
  PricingConfig,
  Speed,
  ToolAnalyticsRow,
  ToolsAnalyticsResponse,
  TokenTotals,
  UserSettings,
} from '../types.js';
import type { PriceResolver } from '../pricing/resolve.js';
import { addBreakdown, addUsageToTotals, costOfUsage, emptyBreakdown, emptyTokenTotals } from '../pricing/money.js';
import { COLD_CACHE_CONTEXT_TOKENS } from '../cost/price-at-read.js';
import type {
  InsightHookRow,
  InsightModelRow,
  InsightSessionRow,
  InsightToolRow,
  InsightsInput,
} from '../cost/insights.js';
import type { ContextItemCost, InjectionCost, ToolCallCost } from '../types.js';
import type { DateRange, SqlScope } from './filters.js';
import {
  CONTEXT_ITEM_COLUMNS,
  INJECTION_COLUMNS,
  TOOL_CALL_COLUMNS,
  contextItemCostsFrom,
  injectionCostsFrom,
  toolCallCostsFrom,
} from './attributed.js';
import { flagsOf, usageOf, type PriceIndexes } from './price-index.js';
import { groupModelRows } from './sessions.js';
import { jsonColumn, num, optStr, str, type Row } from './rows.js';
import { buildCategories } from './detail.js';

/** Idle longer than the 5-minute cache TTL and the next prompt pays full write price again. */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface AnalyticsContext {
  db: DatabaseSync;
  scope: SqlScope;
  range: DateRange;
  resolve: PriceResolver;
  pricing: PricingConfig;
  settings: UserSettings;
  indexes: PriceIndexes;
  /**
   * Scans of the attributed tables are the expensive part of an overview, and overview needs the
   * same rows for categories, tools and insights. They are read and priced at most once per context.
   */
  cache?: {
    toolCalls?: { sessionIds: string[]; costs: ToolCallCost[] };
    injections?: InjectionCost[];
    contextItems?: ContextItemCost[];
  };
}

/** Tool-call rows in range, priced once and reused across categories / tools / insights. */
function scanToolCalls(ctx: AnalyticsContext): { sessionIds: string[]; costs: ToolCallCost[] } {
  const cache = (ctx.cache ??= {});
  if (cache.toolCalls) return cache.toolCalls;
  const rows = ctx.db
    .prepare(`SELECT ${prefixed(TOOL_CALL_COLUMNS, 't')} ${scopedSql(ctx.scope, 'tool_calls', 't')}`)
    .all(...rangeParams(ctx)) as Row[];
  const scan = { sessionIds: rows.map((row) => str(row, 'sessionId')), costs: toolCallCostsFrom(rows, ctx.indexes) };
  cache.toolCalls = scan;
  return scan;
}

/** Injection rows in range, priced once and reused across categories / hooks / insights. */
function scanInjections(ctx: AnalyticsContext): InjectionCost[] {
  const cache = (ctx.cache ??= {});
  if (cache.injections) return cache.injections;
  const rows = ctx.db
    .prepare(`SELECT ${prefixed(INJECTION_COLUMNS, 'i')} ${scopedSql(ctx.scope, 'injections', 'i')}`)
    .all(...rangeParams(ctx)) as Row[];
  const costs = injectionCostsFrom(rows, ctx.indexes);
  cache.injections = costs;
  return costs;
}

/** Whole-context rows in range (assistant history, baseline floors), priced once. */
function scanContextItems(ctx: AnalyticsContext): ContextItemCost[] {
  const cache = (ctx.cache ??= {});
  if (cache.contextItems) return cache.contextItems;
  const rows = ctx.db
    .prepare(`SELECT ${prefixed(CONTEXT_ITEM_COLUMNS, 'c')} ${scopedSql(ctx.scope, 'context_items', 'c')}`)
    .all(...rangeParams(ctx)) as Row[];
  const costs = contextItemCostsFrom(rows, ctx.indexes);
  cache.contextItems = costs;
  return costs;
}

/** `a, b` → `t.a, t.b` so shared column lists can be reused across aliased queries. */
function prefixed(columns: string, alias: string): string {
  return columns
    .split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ');
}

function scopedSql(scope: SqlScope, table: string, alias: string, extra = ''): string {
  return `FROM ${table} ${alias}
    WHERE ${alias}.dateLocal >= ? AND ${alias}.dateLocal <= ?
      AND ${alias}.sessionId IN (SELECT s.id FROM sessions s${scope.sql})${extra}`;
}

function rangeParams(ctx: AnalyticsContext): (string | number)[] {
  return [ctx.range.from, ctx.range.to, ...ctx.scope.params];
}

// `requests` counts distinct top-level requests (one per iterIndex 0 row) — the right number for
// totals that aren't split by model. `billedRequests` counts every billed unit in the group
// (COUNT(*)): when a group is keyed by model (spend-by-model breakdown), that's "how many billed
// iterations landed on this model", which is what a per-model requests column should show — see
// `groupModelRows` in sessions.ts and docs/METHODOLOGY.md §2. A fallback request bills iterIndex 0
// under the final model and iterIndex >=1 under the earlier one(s), so summing `billedRequests`
// across a fallback request's models is intentionally >= 1 while `requests` stays exactly 1.
const REQUEST_SUMS = `SUM(r.input) AS input, SUM(r.output) AS output, SUM(r.cacheRead) AS cacheRead,
  SUM(r.cache5m) AS cache5m, SUM(r.cache1h) AS cache1h, SUM(r.cacheAssumed) AS cacheAssumed,
  SUM(r.thinking) AS thinking,
  SUM(r.webSearchRequests) AS webSearchRequests, SUM(r.webFetchRequests) AS webFetchRequests,
  r.contextTokens AS pricingContextTokens, SUM(r.contextTokens) AS contextTokens, SUM(CASE WHEN r.iterIndex = 0 THEN 1 ELSE 0 END) AS requests,
  COUNT(*) AS billedRequests`;

export function modelRowsInRange(ctx: AnalyticsContext): ModelCostRow[] {
  const rows = ctx.db
    .prepare(
      `SELECT r.model AS model, r.speed AS speed, r.serviceTier AS serviceTier,
        r.inferenceGeo AS inferenceGeo, ${REQUEST_SUMS}
       ${scopedSql(ctx.scope, 'requests', 'r')}
       GROUP BY r.model, r.speed, r.serviceTier, r.inferenceGeo, r.contextTokens`,
    )
    .all(...rangeParams(ctx)) as Row[];
  return groupModelRows(rows, ctx.resolve, ctx.pricing);
}

export function dailyPoints(ctx: AnalyticsContext): DailyPoint[] {
  const rows = ctx.db
    .prepare(
      `SELECT r.dateLocal AS dateLocal, r.model AS model, r.speed AS speed, r.serviceTier AS serviceTier,
        r.inferenceGeo AS inferenceGeo, COUNT(DISTINCT r.sessionId) AS sessions, ${REQUEST_SUMS}
       ${scopedSql(ctx.scope, 'requests', 'r')}
       GROUP BY r.dateLocal, r.model, r.speed, r.serviceTier, r.inferenceGeo, r.contextTokens
       ORDER BY r.dateLocal`,
    )
    .all(...rangeParams(ctx)) as Row[];
  const byDate = new Map<string, DailyPoint>();
  for (const row of rows) {
    const date = str(row, 'dateLocal');
    const usage = usageOf(row, ctx.pricing);
    const resolved = ctx.resolve(str(row, 'model'), flagsOf(row));
    const cost = costOfUsage(usage, resolved, ctx.pricing.webSearchPer1000);
    const point = byDate.get(date) ?? { date, cost: 0, requests: 0, sessions: 0, tokens: emptyTokenTotals() };
    point.cost += cost.total;
    point.requests += num(row, 'requests');
    addUsageToTotals(point.tokens, usage);
    byDate.set(date, point);
  }
  const sessionRows = ctx.db
    .prepare(
      `SELECT r.dateLocal AS dateLocal, COUNT(DISTINCT r.sessionId) AS sessions
       ${scopedSql(ctx.scope, 'requests', 'r')} GROUP BY r.dateLocal`,
    )
    .all(...rangeParams(ctx)) as Row[];
  for (const row of sessionRows) {
    const point = byDate.get(str(row, 'dateLocal'));
    if (point) point.sessions = num(row, 'sessions');
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface RangeCounts {
  sessions: number;
  prompts: number;
  toolCalls: number;
  agents: number;
}

export function rangeCounts(ctx: AnalyticsContext): RangeCounts {
  const params = rangeParams(ctx);
  const sessions = ctx.db
    .prepare(`SELECT COUNT(DISTINCT r.sessionId) AS n ${scopedSql(ctx.scope, 'requests', 'r')}`)
    .get(...params) as Row | undefined;
  const prompts = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n ${scopedSql(ctx.scope, 'messages', 'm', " AND m.kind = 'prompt' AND m.agentId = ''")}`,
    )
    .get(...params) as Row | undefined;
  const toolCalls = ctx.db
    .prepare(`SELECT COUNT(*) AS n ${scopedSql(ctx.scope, 'tool_calls', 't')}`)
    .get(...params) as Row | undefined;
  const agents = ctx.db
    .prepare(
      `SELECT COUNT(DISTINCT r.sessionId || r.agentId) AS n ${scopedSql(ctx.scope, 'requests', 'r', " AND r.agentId <> ''")}`,
    )
    .get(...params) as Row | undefined;
  return {
    sessions: sessions ? num(sessions, 'n') : 0,
    prompts: prompts ? num(prompts, 'n') : 0,
    toolCalls: toolCalls ? num(toolCalls, 'n') : 0,
    agents: agents ? num(agents, 'n') : 0,
  };
}

export function categoriesInRange(ctx: AnalyticsContext, exact: CostBreakdown): CategoryShare {
  return buildCategories(exact, scanToolCalls(ctx).costs, scanInjections(ctx), scanContextItems(ctx));
}

export function toolsAnalytics(ctx: AnalyticsContext): ToolsAnalyticsResponse {
  const { costs, sessionIds: sessionsById } = scanToolCalls(ctx);
  const childCosts = childCostBySession(ctx);

  const byName = new Map<string, ToolAnalyticsRow & { sessionSet: Set<string>; resultChars: number }>();
  costs.forEach((call, i) => {
    const entry = byName.get(call.name) ?? {
      name: call.name,
      calls: 0,
      errors: 0,
      sessions: 0,
      avgResultChars: 0,
      totalResultTokens: 0,
      genCost: 0,
      ingestCost: 0,
      carryCost: 0,
      totalCost: 0,
      childCost: 0,
      sessionSet: new Set<string>(),
      resultChars: 0,
      ...(call.mcpServer ? { mcpServer: call.mcpServer } : {}),
    };
    entry.calls += 1;
    if (call.isError) entry.errors += 1;
    entry.resultChars += call.resultChars;
    entry.totalResultTokens += call.result.tokens;
    entry.genCost += call.genCost;
    entry.ingestCost += call.result.ingestCost;
    entry.carryCost += call.result.carryCost;
    entry.totalCost += call.ownCost;
    const sessionId = sessionsById[i] ?? '';
    entry.sessionSet.add(sessionId);
    if (call.childAgentId) {
      entry.childCost += childCosts.get(`${sessionId} ${call.childAgentId}`) ?? 0;
    } else if (call.childRunId) {
      entry.childCost += childCosts.get(`${sessionId} run:${call.childRunId}`) ?? 0;
    }
    byName.set(call.name, entry);
  });

  const tools: ToolAnalyticsRow[] = [...byName.values()]
    .map(({ sessionSet, resultChars, ...row }) => ({
      ...row,
      sessions: sessionSet.size,
      avgResultChars: row.calls > 0 ? resultChars / row.calls : 0,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
  return { range: ctx.range, tools, total: tools.reduce((sum, t) => sum + t.totalCost, 0) };
}

/** Cost of every agent transcript and workflow run in scope, keyed for tool-call child lookup. */
function childCostBySession(ctx: AnalyticsContext): Map<string, number> {
  const rows = ctx.db
    .prepare(
      `SELECT r.sessionId AS sessionId, r.agentId AS agentId, r.model AS model, r.speed AS speed,
        r.serviceTier AS serviceTier, r.inferenceGeo AS inferenceGeo, ${REQUEST_SUMS}
       FROM requests r
       WHERE r.agentId <> '' AND r.sessionId IN (SELECT s.id FROM sessions s${ctx.scope.sql})
       GROUP BY r.sessionId, r.agentId, r.model, r.speed, r.serviceTier, r.inferenceGeo, r.contextTokens`,
    )
    .all(...ctx.scope.params) as Row[];
  const byAgent = new Map<string, number>();
  for (const row of rows) {
    const key = `${str(row, 'sessionId')} ${str(row, 'agentId')}`;
    const resolved = ctx.resolve(str(row, 'model'), flagsOf(row));
    const cost = costOfUsage(usageOf(row, ctx.pricing), resolved, ctx.pricing.webSearchPer1000).total;
    byAgent.set(key, (byAgent.get(key) ?? 0) + cost);
  }
  const agentRows = ctx.db
    .prepare(
      `SELECT sessionId, agentId, runId FROM agents
       WHERE sessionId IN (SELECT s.id FROM sessions s${ctx.scope.sql})`,
    )
    .all(...ctx.scope.params) as Row[];
  for (const row of agentRows) {
    const runId = optStr(row, 'runId');
    if (!runId) continue;
    const key = `${str(row, 'sessionId')} run:${runId}`;
    const agentKey = `${str(row, 'sessionId')} ${str(row, 'agentId')}`;
    byAgent.set(key, (byAgent.get(key) ?? 0) + (byAgent.get(agentKey) ?? 0));
  }
  return byAgent;
}

export function modelsAnalytics(ctx: AnalyticsContext): ModelsAnalyticsResponse {
  const models = modelRowsInRange(ctx);
  const dailyRows = ctx.db
    .prepare(
      `SELECT r.dateLocal AS dateLocal, r.model AS model, r.speed AS speed, r.serviceTier AS serviceTier,
        r.inferenceGeo AS inferenceGeo, ${REQUEST_SUMS}
       ${scopedSql(ctx.scope, 'requests', 'r')}
       GROUP BY r.dateLocal, r.model, r.speed, r.serviceTier, r.inferenceGeo, r.contextTokens
       ORDER BY r.dateLocal`,
    )
    .all(...rangeParams(ctx)) as Row[];
  const daily = new Map<string, Record<string, number>>();
  const bySpeed = new Map<Speed, { speed: Speed; requests: number; cost: number }>();
  for (const row of dailyRows) {
    const date = str(row, 'dateLocal');
    const model = str(row, 'model');
    const flags = flagsOf(row);
    const cost = costOfUsage(usageOf(row, ctx.pricing), ctx.resolve(model, flags), ctx.pricing.webSearchPer1000).total;
    const entry = daily.get(date) ?? {};
    entry[model] = (entry[model] ?? 0) + cost;
    daily.set(date, entry);
    const speedEntry = bySpeed.get(flags.speed) ?? { speed: flags.speed, requests: 0, cost: 0 };
    speedEntry.requests += num(row, 'requests');
    speedEntry.cost += cost;
    bySpeed.set(flags.speed, speedEntry);
  }
  return {
    range: ctx.range,
    models,
    daily: [...daily.entries()].map(([date, byModel]) => ({ date, byModel })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    bySpeed: [...bySpeed.values()],
  };
}

/** basename of the first whitespace-separated token of a hook command, e.g.
 * `"/usr/local/bin/notify-stop.sh --quiet"` → `"notify-stop.sh"`. */
export function commandLabel(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const first = command.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const base = first.split('/').pop();
  return base && base.length > 0 ? base : first;
}

/**
 * Presentable label for a hook-analytics row. A named hook (`hookName` set by the transcript)
 * just uses its name. An unnamed one — e.g. a bare `stop_hook_summary` that carries only
 * `command` + `durationMs`, no `hookName` — falls back to its hook event plus a short
 * command-derived label ("Stop · notify-stop.sh") instead of the raw `(unnamed)` placeholder, so
 * distinct unnamed hooks are still recognizable even though they share one aggregated row.
 */
export function displayNameOf(
  hookName: string,
  hookEvent: string | undefined,
  command: string | undefined,
): string {
  if (hookName !== '(unnamed)') return hookName;
  const label = commandLabel(command);
  if (hookEvent && label) return `${hookEvent} · ${label}`;
  return hookEvent ?? label ?? hookName;
}

export function hooksAnalytics(ctx: AnalyticsContext): HooksAnalyticsResponse {
  const params = rangeParams(ctx);
  const runRows = ctx.db
    .prepare(
      `SELECT COALESCE(h.hookName, '(unnamed)') AS hookName, h.hookEvent AS hookEvent,
        MIN(h.command) AS command,
        COUNT(*) AS runs,
        SUM(CASE WHEN h.kind = 'blocking_error' OR (h.exitCode IS NOT NULL AND h.exitCode <> 0) THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN h.timedOut <> 0 THEN 1 ELSE 0 END) AS timeouts,
        SUM(COALESCE(h.durationMs, 0)) AS totalDurationMs,
        SUM(h.injectedChars) AS injectedChars
       ${scopedSql(ctx.scope, 'hook_runs', 'h')}
       GROUP BY hookName, h.hookEvent`,
    )
    .all(...params) as Row[];

  const injections = scanInjections(ctx);

  const hookCostByName = new Map<string, number>();
  const harness = new Map<string, HarnessAnalyticsRow>();
  let hookEstCost = 0;
  let harnessEstCost = 0;
  for (const injection of injections) {
    const cost = injection.cost.ingestCost + injection.cost.carryCost;
    if (injection.kind === 'hook_context' || injection.kind === 'hook_blocking' || injection.kind === 'hook_stdout') {
      const key = injection.hookName ?? '(unnamed)';
      hookCostByName.set(key, (hookCostByName.get(key) ?? 0) + cost);
      hookEstCost += cost;
      continue;
    }
    if (injection.kind !== 'attachment') continue;
    const entry = harness.get(injection.name) ?? {
      attachmentType: injection.name,
      occurrences: 0,
      chars: 0,
      estCost: 0,
    };
    entry.occurrences += 1;
    entry.chars += injection.chars;
    entry.estCost += cost;
    harness.set(injection.name, entry);
    harnessEstCost += cost;
  }

  const hooks: HookAnalyticsRow[] = runRows.map((row) => {
    const hookName = str(row, 'hookName');
    const runs = num(row, 'runs');
    const totalDurationMs = num(row, 'totalDurationMs');
    const command = optStr(row, 'command');
    const hookEvent = optStr(row, 'hookEvent');
    const out: HookAnalyticsRow = {
      hookName,
      // `hookName` stays '(unnamed)' for back compat with existing consumers; `displayName` is
      // the presentable label, derived from the hook event + a command-derived label when the
      // transcript never reported a name (a bare `stop_hook_summary` carries only command +
      // durationMs — SPEC §3, docs/METHODOLOGY.md §2). Named hooks just echo their name.
      displayName: displayNameOf(hookName, hookEvent, command),
      runs,
      failures: num(row, 'failures'),
      timeouts: num(row, 'timeouts'),
      totalDurationMs,
      avgDurationMs: runs > 0 ? totalDurationMs / runs : 0,
      injectedChars: num(row, 'injectedChars'),
      estCost: hookCostByName.get(hookName) ?? 0,
    };
    if (command) out.command = command;
    if (hookEvent) out.hookEvent = hookEvent;
    return out;
  });
  hooks.sort((a, b) => b.estCost - a.estCost || b.totalDurationMs - a.totalDurationMs);

  return {
    range: ctx.range,
    hooks,
    harness: [...harness.values()].sort((a, b) => b.estCost - a.estCost),
    totals: {
      hookEstCost,
      harnessEstCost,
      hookDurationMs: hooks.reduce((sum, h) => sum + h.totalDurationMs, 0),
    },
  };
}

export function attributionAnalytics(ctx: AnalyticsContext): AttributionAnalyticsResponse {
  const params = rangeParams(ctx);
  const groupBy = (column: 'skill' | 'plugin' | 'mcpServer'): { name: string; requests: number; cost: number }[] => {
    const rows = ctx.db
      .prepare(
        `SELECT r.${column} AS name, r.model AS model, r.speed AS speed, r.serviceTier AS serviceTier,
          r.inferenceGeo AS inferenceGeo, ${REQUEST_SUMS}
         ${scopedSql(ctx.scope, 'requests', 'r', ` AND r.${column} IS NOT NULL AND r.${column} <> ''`)}
         GROUP BY r.${column}, r.model, r.speed, r.serviceTier, r.inferenceGeo, r.contextTokens`,
      )
      .all(...params) as Row[];
    const byName = new Map<string, { name: string; requests: number; cost: number }>();
    for (const row of rows) {
      const name = str(row, 'name');
      const entry = byName.get(name) ?? { name, requests: 0, cost: 0 };
      entry.requests += num(row, 'requests');
      entry.cost += costOfUsage(
        usageOf(row, ctx.pricing),
        ctx.resolve(str(row, 'model'), flagsOf(row)),
        ctx.pricing.webSearchPer1000,
      ).total;
      byName.set(name, entry);
    }
    return [...byName.values()].sort((a, b) => b.cost - a.cost);
  };

  const mcpToolCalls = ctx.db
    .prepare(
      `SELECT t.mcpServer AS name, COUNT(*) AS calls
       ${scopedSql(ctx.scope, 'tool_calls', 't', " AND t.mcpServer IS NOT NULL AND t.mcpServer <> ''")}
       GROUP BY t.mcpServer`,
    )
    .all(...params) as Row[];
  const toolCallsByServer = new Map<string, number>();
  for (const row of mcpToolCalls) toolCallsByServer.set(str(row, 'name'), num(row, 'calls'));

  const mcpServers = groupBy('mcpServer').map((row) => ({
    ...row,
    toolCalls: toolCallsByServer.get(row.name) ?? 0,
  }));
  for (const [name, calls] of toolCallsByServer) {
    if (!mcpServers.some((s) => s.name === name)) {
      mcpServers.push({ name, requests: 0, cost: 0, toolCalls: calls });
    }
  }

  const commandRows = ctx.db
    .prepare(`SELECT s.localCommandsJson AS localCommandsJson FROM sessions s${ctx.scope.sql}`)
    .all(...ctx.scope.params) as Row[];
  const commandCounts = new Map<string, number>();
  for (const row of commandRows) {
    for (const name of jsonColumn<string[]>(row, 'localCommandsJson', [])) {
      commandCounts.set(name, (commandCounts.get(name) ?? 0) + 1);
    }
  }

  return {
    range: ctx.range,
    skills: groupBy('skill'),
    plugins: groupBy('plugin'),
    mcpServers: mcpServers.sort((a, b) => b.cost - a.cost || b.toolCalls - a.toolCalls),
    localCommands: [...commandCounts.entries()]
      .map(([name, uses]) => ({ name, uses }))
      .sort((a, b) => b.uses - a.uses),
  };
}

interface RequestScanTotals {
  contextTokensTotal: number;
  coldCacheRequests: number;
  coldCacheCost: number;
  idleGapExpiries: number;
  idleGapCost: number;
}

/**
 * One sequential pass over the in-range requests of every session in scope, using LAG() to spot
 * idle gaps. Cold-cache and idle-gap facts both come from this pass.
 */
function scanRequests(ctx: AnalyticsContext): Map<string, RequestScanTotals> {
  const rows = ctx.db
    .prepare(
      `SELECT sessionId, agentId, seq, ts, dateLocal, model, speed, serviceTier, inferenceGeo,
        input, output, cacheRead, cache5m, cache1h, cacheAssumed, thinking, webSearchRequests, webFetchRequests,
        contextTokens,
        LAG(ts) OVER (PARTITION BY sessionId, agentId ORDER BY seq) AS prevTs
       FROM requests
       WHERE iterIndex = 0 AND sessionId IN (SELECT s.id FROM sessions s${ctx.scope.sql})
       ORDER BY sessionId, agentId, seq`,
    )
    .all(...ctx.scope.params) as Row[];
  const out = new Map<string, RequestScanTotals>();
  for (const row of rows) {
    const date = str(row, 'dateLocal');
    if (date < ctx.range.from || date > ctx.range.to) continue;
    const sessionId = str(row, 'sessionId');
    const totals = out.get(sessionId) ?? {
      contextTokensTotal: 0,
      coldCacheRequests: 0,
      coldCacheCost: 0,
      idleGapExpiries: 0,
      idleGapCost: 0,
    };
    totals.contextTokensTotal += num(row, 'contextTokens');
    const cold = num(row, 'contextTokens') > COLD_CACHE_CONTEXT_TOKENS && num(row, 'cacheRead') === 0;
    if (cold) {
      const cost = costOfUsage(
        usageOf(row, ctx.pricing),
        ctx.resolve(str(row, 'model'), flagsOf(row)),
        ctx.pricing.webSearchPer1000,
      ).total;
      totals.coldCacheRequests += 1;
      totals.coldCacheCost += cost;
      const prevTs = optStr(row, 'prevTs');
      const ts = str(row, 'ts');
      if (prevTs && ts) {
        const gap = new Date(ts).getTime() - new Date(prevTs).getTime();
        if (Number.isFinite(gap) && gap > CACHE_TTL_MS) {
          totals.idleGapExpiries += 1;
          totals.idleGapCost += cost;
        }
      }
    }
    out.set(sessionId, totals);
  }
  return out;
}

/** Rewarm cost per session: the cache-write cost of the first request after each boundary. */
function rewarmBySession(ctx: AnalyticsContext): Map<string, { compactions: number; rewarmCost: number }> {
  const rows = ctx.db
    .prepare(
      `SELECT c.sessionId AS sessionId,
        (SELECT r.model FROM requests r WHERE r.sessionId = c.sessionId AND r.agentId = c.agentId
           AND r.seq > c.seq AND r.iterIndex = 0 ORDER BY r.seq LIMIT 1) AS model,
        (SELECT r.speed FROM requests r WHERE r.sessionId = c.sessionId AND r.agentId = c.agentId
           AND r.seq > c.seq AND r.iterIndex = 0 ORDER BY r.seq LIMIT 1) AS speed,
        (SELECT r.serviceTier FROM requests r WHERE r.sessionId = c.sessionId AND r.agentId = c.agentId
           AND r.seq > c.seq AND r.iterIndex = 0 ORDER BY r.seq LIMIT 1) AS serviceTier,
        (SELECT r.inferenceGeo FROM requests r WHERE r.sessionId = c.sessionId AND r.agentId = c.agentId
           AND r.seq > c.seq AND r.iterIndex = 0 ORDER BY r.seq LIMIT 1) AS inferenceGeo,
        (SELECT r.cache5m FROM requests r WHERE r.sessionId = c.sessionId AND r.agentId = c.agentId
           AND r.seq > c.seq AND r.iterIndex = 0 ORDER BY r.seq LIMIT 1) AS cache5m,
        (SELECT r.cache1h FROM requests r WHERE r.sessionId = c.sessionId AND r.agentId = c.agentId
           AND r.seq > c.seq AND r.iterIndex = 0 ORDER BY r.seq LIMIT 1) AS cache1h,
        (SELECT r.cacheAssumed FROM requests r WHERE r.sessionId = c.sessionId AND r.agentId = c.agentId
           AND r.seq > c.seq AND r.iterIndex = 0 ORDER BY r.seq LIMIT 1) AS cacheAssumed
       ${scopedSql(ctx.scope, 'compactions', 'c')}`,
    )
    .all(...rangeParams(ctx)) as Row[];
  const out = new Map<string, { compactions: number; rewarmCost: number }>();
  for (const row of rows) {
    const sessionId = str(row, 'sessionId');
    const entry = out.get(sessionId) ?? { compactions: 0, rewarmCost: 0 };
    entry.compactions += 1;
    const model = optStr(row, 'model');
    if (model) {
      const resolved = ctx.resolve(model, flagsOf(row));
      const write = usageOf(row, ctx.pricing);
      entry.rewarmCost +=
        write.cache5m * resolved.perToken.cacheWrite5m + write.cache1h * resolved.perToken.cacheWrite1h;
    }
    out.set(sessionId, entry);
  }
  return out;
}

export function buildInsightsInput(ctx: AnalyticsContext, totalCost: number): InsightsInput {
  const params = rangeParams(ctx);
  const sessionRows = ctx.db
    .prepare(
      `SELECT s.id AS id, s.title AS title, s.projectId AS projectId,
        COALESCE(p.path, s.cwd, s.projectId) AS projectPath, s.promptCount AS promptCount
       FROM sessions s${ctx.scope.sql}`,
    )
    .all(...ctx.scope.params) as Row[];

  const modelRows = ctx.db
    .prepare(
      `SELECT r.sessionId AS sessionId, r.agentId AS agentId, r.model AS model, r.speed AS speed,
        r.serviceTier AS serviceTier, r.inferenceGeo AS inferenceGeo, ${REQUEST_SUMS}
       ${scopedSql(ctx.scope, 'requests', 'r')}
       GROUP BY r.sessionId, r.agentId, r.model, r.speed, r.serviceTier, r.inferenceGeo, r.contextTokens`,
    )
    .all(...params) as Row[];

  const titles = new Map<string, string>();
  for (const row of sessionRows) titles.set(str(row, 'id'), str(row, 'title'));

  const sessionModels: InsightModelRow[] = [];
  const costBySession = new Map<string, number>();
  const requestsBySession = new Map<string, number>();
  for (const row of modelRows) {
    const sessionId = str(row, 'sessionId');
    const usage = usageOf(row, ctx.pricing);
    const resolved = ctx.resolve(str(row, 'model'), flagsOf(row));
    const cost = costOfUsage(usage, resolved, ctx.pricing.webSearchPer1000).total;
    sessionModels.push({
      sessionId,
      title: titles.get(sessionId) ?? sessionId,
      model: str(row, 'model'),
      family: resolved.family,
      isAgent: str(row, 'agentId') !== '',
      requests: num(row, 'requests'),
      cost,
      usage,
    });
    costBySession.set(sessionId, (costBySession.get(sessionId) ?? 0) + cost);
    requestsBySession.set(sessionId, (requestsBySession.get(sessionId) ?? 0) + num(row, 'requests'));
  }

  const scan = scanRequests(ctx);
  const rewarm = rewarmBySession(ctx);
  const sessions: InsightSessionRow[] = sessionRows.map((row) => {
    const id = str(row, 'id');
    const totals = scan.get(id);
    const compaction = rewarm.get(id);
    return {
      sessionId: id,
      title: str(row, 'title'),
      projectId: str(row, 'projectId'),
      projectPath: str(row, 'projectPath'),
      cost: costBySession.get(id) ?? 0,
      promptCount: num(row, 'promptCount'),
      requestCount: requestsBySession.get(id) ?? 0,
      contextTokensTotal: totals?.contextTokensTotal ?? 0,
      compactionCount: compaction?.compactions ?? 0,
      rewarmCost: compaction?.rewarmCost ?? 0,
      coldCacheRequests: totals?.coldCacheRequests ?? 0,
      coldCacheCost: totals?.coldCacheCost ?? 0,
      idleGapExpiries: totals?.idleGapExpiries ?? 0,
      idleGapCost: totals?.idleGapCost ?? 0,
    };
  });

  const tools = toolsAnalytics(ctx);
  const perToolSessions = toolSessionAmounts(ctx, titles);
  const insightTools: InsightToolRow[] = tools.tools.map((tool) => ({
    name: tool.name,
    calls: tool.calls,
    genCost: tool.genCost,
    ingestCost: tool.ingestCost,
    carryCost: tool.carryCost,
    topSessions: perToolSessions.get(tool.name) ?? [],
  }));

  const hooksResponse = hooksAnalytics(ctx);
  const insightHooks: InsightHookRow[] = hooksResponse.hooks.map((hook) => ({
    hookName: hook.hookName,
    hookEvent: hook.hookEvent,
    runs: hook.runs,
    failures: hook.failures,
    totalDurationMs: hook.totalDurationMs,
    estCost: hook.estCost,
  }));

  return {
    totalCost,
    sessions,
    sessionModels,
    tools: insightTools,
    hooks: insightHooks,
    harnessCost: hooksResponse.totals.harnessEstCost,
    hookCost: hooksResponse.totals.hookEstCost,
  };
}

function toolSessionAmounts(
  ctx: AnalyticsContext,
  titles: ReadonlyMap<string, string>,
): Map<string, { sessionId: string; title: string; amount: number }[]> {
  const { costs, sessionIds } = scanToolCalls(ctx);
  const byTool = new Map<string, Map<string, number>>();
  costs.forEach((call, i) => {
    const sessionId = sessionIds[i] ?? '';
    const perSession = byTool.get(call.name) ?? new Map<string, number>();
    perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + call.result.carryCost);
    byTool.set(call.name, perSession);
  });
  const out = new Map<string, { sessionId: string; title: string; amount: number }[]>();
  for (const [name, perSession] of byTool) {
    out.set(
      name,
      [...perSession.entries()]
        .map(([sessionId, amount]) => ({ sessionId, title: titles.get(sessionId) ?? sessionId, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5),
    );
  }
  return out;
}

export function totalsFromModelRows(rows: readonly ModelCostRow[]): {
  cost: CostBreakdown;
  tokens: TokenTotals;
  requests: number;
} {
  const cost = emptyBreakdown();
  const tokens = emptyTokenTotals();
  let requests = 0;
  for (const row of rows) {
    addBreakdown(cost, row.cost);
    tokens.input += row.tokens.input;
    tokens.output += row.tokens.output;
    tokens.cacheRead += row.tokens.cacheRead;
    tokens.cache5m += row.tokens.cache5m;
    tokens.cache1h += row.tokens.cache1h;
    tokens.thinking += row.tokens.thinking;
    tokens.webSearchRequests += row.tokens.webSearchRequests;
    tokens.context += row.tokens.context;
    requests += row.requests;
  }
  return { cost, tokens, requests };
}

/** Request counts per project inside the range, for the overview's project table. */
export function requestCountsByProject(ctx: AnalyticsContext): Map<string, number> {
  const rows = ctx.db
    .prepare(
      `SELECT (SELECT s2.projectId FROM sessions s2 WHERE s2.id = r.sessionId) AS projectId, COUNT(*) AS n
       ${scopedSql(ctx.scope, 'requests', 'r', ' AND r.iterIndex = 0')}
       GROUP BY projectId`,
    )
    .all(...rangeParams(ctx)) as Row[];
  return new Map(rows.map((row) => [str(row, 'projectId'), num(row, 'n')]));
}

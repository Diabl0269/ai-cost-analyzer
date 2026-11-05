/**
 * Session summaries. Tokens are aggregated in SQL (grouped by model and billing flags), then
 * priced once per group in JS — that keeps the number of price lookups proportional to distinct
 * models rather than to requests.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  CostBreakdown,
  ModelCostRow,
  PricingConfig,
  ReportedComparison,
  ReportedCost,
  SessionSummary,
  TokenTotals,
  TokenUsage,
  UserSettings,
} from '../types.js';
import { compareReported, computedTokenClasses } from '../cost/reported.js';
import type { PriceResolver } from '../pricing/resolve.js';
import { addBreakdown, addUsageToTotals, costOfUsage, emptyBreakdown, emptyTokenTotals } from '../pricing/money.js';
import { jsonColumn, num, optStr, str, type Row } from './rows.js';
import { flagsOf, usageOf } from './price-index.js';
import { MAIN_AGENT } from './write-session.js';
import type { DateRange, SqlScope } from './filters.js';

export interface SessionCostBundle {
  tokens: TokenTotals;
  cost: CostBreakdown;
  costMain: number;
  costAgents: number;
  costWorkflows: number;
  requests: number;
  models: string[];
  unpriced: boolean;
}

function emptyBundle(): SessionCostBundle {
  return {
    tokens: emptyTokenTotals(),
    cost: emptyBreakdown(),
    costMain: 0,
    costAgents: 0,
    costWorkflows: 0,
    requests: 0,
    models: [],
    unpriced: false,
  };
}

// See the matching comment on `REQUEST_SUMS` in analytics.ts: `requests` is the exact per-session
// request count, `billedRequests` is per-billed-unit (used only where the group is keyed by model).
const GROUPED_USAGE = `
  SUM(input) AS input, SUM(output) AS output, SUM(cacheRead) AS cacheRead,
  SUM(cache5m) AS cache5m, SUM(cache1h) AS cache1h, SUM(cacheAssumed) AS cacheAssumed,
  SUM(thinking) AS thinking,
  SUM(webSearchRequests) AS webSearchRequests, SUM(webFetchRequests) AS webFetchRequests,
  contextTokens AS pricingContextTokens, SUM(contextTokens) AS contextTokens,
  SUM(CASE WHEN iterIndex = 0 AND COALESCE(messageId, '') NOT LIKE 'copilot-aggregate-%' THEN 1 ELSE 0 END) AS requests,
  SUM(CASE WHEN COALESCE(messageId, '') NOT LIKE 'copilot-aggregate-%' THEN 1 ELSE 0 END) AS billedRequests`;

/** agentId → runId for the sessions in scope, so agent spend can be split from workflow spend. */
function workflowAgents(db: DatabaseSync, scope: SqlScope): Set<string> {
  const rows = db
    .prepare(
      `SELECT sessionId, agentId FROM agents
       WHERE runId IS NOT NULL AND sessionId IN (SELECT s.id FROM sessions s${scope.sql})`,
    )
    .all(...scope.params) as Row[];
  return new Set(rows.map((row) => `${str(row, 'sessionId')} ${str(row, 'agentId')}`));
}

/**
 * Session cost bundles for every session in `scope`.
 *
 * `range` narrows the *requests* that are summed to those whose own local date falls inside it —
 * the analytics semantics. Without it the whole session is summed, which is what the session
 * detail page and the sessions list want. A session in `scope` with no request in `range` is
 * absent from the returned map, so callers can tell "no spend in range" from "no spend at all".
 */
export function loadSessionCosts(
  db: DatabaseSync,
  scope: SqlScope,
  resolve: PriceResolver,
  pricing: PricingConfig,
  range?: DateRange,
): Map<string, SessionCostBundle> {
  const rangeClause = range ? 'dateLocal >= ? AND dateLocal <= ? AND ' : '';
  const rangeParams = range ? [range.from, range.to] : [];
  const rows = db
    .prepare(
      `SELECT sessionId, agentId, model, speed, serviceTier, inferenceGeo, ${GROUPED_USAGE}
       FROM requests
       WHERE ${rangeClause}sessionId IN (SELECT s.id FROM sessions s${scope.sql})
       GROUP BY sessionId, agentId, model, speed, serviceTier, inferenceGeo, contextTokens`,
    )
    .all(...rangeParams, ...scope.params) as Row[];
  const workflow = workflowAgents(db, scope);
  const out = new Map<string, SessionCostBundle>();
  const modelSets = new Map<string, Set<string>>();
  for (const row of rows) {
    const sessionId = str(row, 'sessionId');
    const agentId = str(row, 'agentId');
    const usage = usageOf(row, pricing);
    const resolved = resolve(str(row, 'model'), flagsOf(row));
    const cost = costOfUsage(usage, resolved, pricing.webSearchPer1000);
    const bundle = out.get(sessionId) ?? emptyBundle();
    addUsageToTotals(bundle.tokens, usage);
    addBreakdown(bundle.cost, cost);
    bundle.requests += num(row, 'requests');
    if (resolved.unpriced) bundle.unpriced = true;
    if (agentId === MAIN_AGENT) bundle.costMain += cost.total;
    else if (workflow.has(`${sessionId} ${agentId}`)) bundle.costWorkflows += cost.total;
    else bundle.costAgents += cost.total;
    out.set(sessionId, bundle);
    const models = modelSets.get(sessionId) ?? new Set<string>();
    models.add(str(row, 'model'));
    modelSets.set(sessionId, models);
  }
  for (const [sessionId, models] of modelSets) {
    const bundle = out.get(sessionId);
    if (bundle) bundle.models = [...models].sort();
  }
  return out;
}

/** Groups one session's requests by model for the detail page. */
export function loadModelRows(
  db: DatabaseSync,
  sessionId: string,
  resolve: PriceResolver,
  pricing: PricingConfig,
): ModelCostRow[] {
  const rows = db
    .prepare(
      `SELECT model, speed, serviceTier, inferenceGeo, ${GROUPED_USAGE}
       FROM requests WHERE sessionId = ?
       GROUP BY model, speed, serviceTier, inferenceGeo, contextTokens`,
    )
    .all(sessionId) as Row[];
  return groupModelRows(rows, resolve, pricing);
}

/**
 * Groups rows already aggregated per model (each row's group key includes `model`) into one
 * `ModelCostRow` per model. `requests` here is the number of *billed iterations* attributed to
 * this model (`billedRequests` from `GROUPED_USAGE`/`REQUEST_SUMS`), not the number of top-level
 * requests: a fallback request bills its final iteration under one model and its earlier
 * iteration(s) under another, so each model involved gets +1 here for that single request. That
 * means `sum(byModel[].requests)` can be slightly more than the session/range's total request
 * count — expected, see docs/METHODOLOGY.md §2. Falls back to the exact-count `requests` column
 * when `billedRequests` isn't present (older callers/fixtures), which undercounts fallback rows
 * but never throws.
 */
export function groupModelRows(
  rows: readonly Row[],
  resolve: PriceResolver,
  pricing: PricingConfig,
): ModelCostRow[] {
  const byModel = new Map<string, ModelCostRow>();
  for (const row of rows) {
    const model = str(row, 'model');
    const usage: TokenUsage = usageOf(row, pricing);
    const resolved = resolve(model, flagsOf(row));
    const cost = costOfUsage(usage, resolved, pricing.webSearchPer1000);
    const requests = 'billedRequests' in row ? num(row, 'billedRequests') : num(row, 'requests');
    const existing = byModel.get(model);
    if (existing) {
      existing.requests += requests;
      addUsageToTotals(existing.tokens, usage);
      addBreakdown(existing.cost, cost);
      existing.unpriced = existing.unpriced || resolved.unpriced;
    } else {
      const tokens = emptyTokenTotals();
      addUsageToTotals(tokens, usage);
      byModel.set(model, {
        model,
        modelKey: resolved.modelKey,
        label: resolved.label,
        family: resolved.family,
        requests,
        tokens,
        cost,
        unpriced: resolved.unpriced,
      });
    }
  }
  return [...byModel.values()].sort((a, b) => b.cost.total - a.cost.total);
}

/**
 * The session's `cost-state` tally, or undefined when it never wrote one. Kept here so the
 * summary and the detail page derive the comparison from exactly the same row and bundle.
 */
export function reportedCostOf(row: Row): ReportedCost | undefined {
  return jsonColumn<ReportedCost | undefined>(row, 'reportedJson', undefined);
}

export function reportedComparisonOf(row: Row, bundle: SessionCostBundle): ReportedComparison | undefined {
  const reported = reportedCostOf(row);
  if (!reported) return undefined;
  return compareReported(computedTokenClasses(bundle.tokens), bundle.cost.total, reported);
}

export interface SummaryOptions {
  /**
   * True when `bundle` covers only the requests inside a date range. The summary then reports the
   * in-range request count and drops the `cost-state` comparison: that tally belongs to the whole
   * session (in fact to a whole Claude Code process), so comparing a window against it is
   * meaningless rather than merely imprecise.
   */
  rangeScoped?: boolean;
}

export function toSessionSummary(
  row: Row,
  bundle: SessionCostBundle,
  settings: UserSettings,
  projectPath: string,
  options: SummaryOptions = {},
): SessionSummary {
  const summary: SessionSummary = {
    id: str(row, 'id'),
    provider: str(row, 'provider') === 'copilot' ? 'copilot' : str(row, 'provider') === 'codex' ? 'codex' : 'claude',
    ...(num(row, 'usageIncomplete') ? { usageIncomplete: true } : {}),
    projectId: str(row, 'projectId'),
    projectPath,
    title: str(row, 'title'),
    titleSource: str(row, 'titleSource') as SessionSummary['titleSource'],
    firstPrompt: str(row, 'firstPrompt'),
    startedAt: str(row, 'startedAt'),
    endedAt: str(row, 'endedAt'),
    durationMs: num(row, 'durationMs'),
    activeMs: num(row, 'activeMs'),
    models: bundle.models.length > 0 ? bundle.models : jsonColumn<string[]>(row, 'modelsJson', []),
    promptCount: num(row, 'promptCount'),
    requestCount: options.rangeScoped ? bundle.requests : num(row, 'requestCount'),
    toolCallCount: num(row, 'toolCallCount'),
    agentCount: num(row, 'agentCount'),
    workflowRunCount: num(row, 'workflowRunCount'),
    compactionCount: num(row, 'compactionCount'),
    apiErrorCount: num(row, 'apiErrorCount'),
    hookRunCount: num(row, 'hookRunCount'),
    tokens: bundle.tokens,
    cost: bundle.cost,
    costMain: bundle.costMain,
    costAgents: bundle.costAgents,
    costWorkflows: bundle.costWorkflows,
    reportedCostUsd: options.rangeScoped || row['reportedCostUsd'] === null ? null : num(row, 'reportedCostUsd'),
    pinned: settings.pinnedSessionIds.includes(str(row, 'id')),
    unpriced: bundle.unpriced,
  };
  const entrypoint = optStr(row, 'entrypoint');
  if (entrypoint) summary.entrypoint = entrypoint;
  const sessionKind = optStr(row, 'sessionKind');
  if (sessionKind) summary.sessionKind = sessionKind;
  const gitBranch = optStr(row, 'gitBranch');
  if (gitBranch) summary.gitBranch = gitBranch;
  const version = optStr(row, 'version');
  if (version) summary.version = version;
  const effort = optStr(row, 'effort');
  if (effort) summary.effort = effort;
  const continuedIn = optStr(row, 'continuedInSessionId');
  if (continuedIn) summary.continuedInSessionId = continuedIn;
  if (!options.rangeScoped) {
    const comparison = reportedComparisonOf(row, bundle);
    if (comparison) summary.reportedStatus = comparison.status;
  }
  return summary;
}

export const SESSION_COLUMNS =
  's.*, COALESCE(p.path, s.cwd, s.projectId) AS projectPath, COALESCE(p.isScratch, 0) AS isScratch';

/**
 * Loads full summaries for every session matching `scope`, priced with the caller's resolver.
 * With `range`, each summary's cost and request count cover only that window — what the overview
 * needs so its "top sessions" cannot add up to more than the range total.
 */
export function loadSessionSummaries(
  db: DatabaseSync,
  scope: SqlScope,
  resolve: PriceResolver,
  pricing: PricingConfig,
  settings: UserSettings,
  range?: DateRange,
): SessionSummary[] {
  const rows = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s${scope.sql}`)
    .all(...scope.params) as Row[];
  const costs = loadSessionCosts(db, scope, resolve, pricing, range);
  const options: SummaryOptions = range ? { rangeScoped: true } : {};
  return rows.map((row) =>
    toSessionSummary(row, costs.get(str(row, 'id')) ?? emptyBundle(), settings, str(row, 'projectPath'), options),
  );
}

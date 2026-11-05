/**
 * Read side of the index: every method in `core/store.ts`.
 *
 * Rules that hold throughout: all SQL is parameterized (table and column names are literals in the
 * source, never interpolated from input); money is computed at read time from stored token counts
 * and the caller's `PricingConfig`, so a pricing edit or a `whatIf` swap needs no re-indexing.
 */
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { QueryContext, Store, StoreStatus } from '../store.js';
import type {
  AgentTreeResponse,
  AttributionAnalyticsResponse,
  HooksAnalyticsResponse,
  InsightsResponse,
  ModelsAnalyticsResponse,
  OverviewResponse,
  ProjectSummary,
  ProjectsResponse,
  RangeQuery,
  SearchQuery,
  SearchResponse,
  SearchSessionGroup,
  SessionDetail,
  SessionExport,
  SessionSort,
  SessionSummary,
  SessionsQuery,
  SessionsResponse,
  ToolsAnalyticsResponse,
  TranscriptPage,
} from '../types.js';
import { createPriceResolver, findModelPrice, parseWhatIf, type PriceResolver } from '../pricing/resolve.js';
import { costOfUsage, emptyBreakdown, emptyTokenTotals } from '../pricing/money.js';
import { budgetStatus, planComparison } from '../cost/plan.js';
import { computeInsights } from '../cost/insights.js';
import { META_LAST_INDEXED_AT, getMeta, openDatabase } from './schema.js';
import { decodeCursor, encodeCursor, resolveRange, sessionScope, type SqlScope } from './filters.js';
import {
  SESSION_COLUMNS,
  loadModelRows,
  loadSessionCosts,
  loadSessionSummaries,
  reportedComparisonOf,
  toSessionSummary,
  type SessionCostBundle,
} from './sessions.js';
import { flagsOf, loadPriceIndexes, loadSessionPriceIndexes, usageOf } from './price-index.js';
import {
  buildAgentTree,
  buildCategories,
  buildTurns,
  loadAgentTotals,
  loadCompactions,
  loadContextItems,
  loadHookRuns,
  loadInjections,
  loadRequestCosts,
  loadToolCalls,
} from './detail.js';
import { getTranscriptPage } from './transcript.js';
import { countContentHits, searchContent, searchTitles } from './search.js';
import { sessionsToCsv } from './csv.js';
import {
  attributionAnalytics,
  buildInsightsInput,
  categoriesInRange,
  dailyPoints,
  hooksAnalytics,
  modelRowsInRange,
  modelsAnalytics,
  rangeCounts,
  requestCountsByProject,
  toolsAnalytics,
  totalsFromModelRows,
  type AnalyticsContext,
} from './analytics.js';
import { jsonColumn, nullableNum, num, optStr, str, type Row } from './rows.js';
import { isScratchPath, worktreeParent } from './projects.js';
import { MAIN_AGENT } from './write-session.js';

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;
const TOP_SESSIONS = 8;
const MAX_SEARCH_HITS_PER_SESSION = 3;
/** Sessions a title search considers, before paging. */
const TITLE_SCAN_LIMIT = 200;
/** First guess at how many ranked hits it takes to cover one page of sessions. */
const HITS_PER_SESSION_ESTIMATE = 20;
const MIN_HIT_SCAN = 100;
const HIT_SCAN_GROWTH = 4;
/** Hard stop on the ranked-hit scan; ~13k hits is the whole corpus for a stop-word query. */
const MAX_HIT_SCAN = 20_000;

/** Index just after `cursorId` in `ids`, or 0 when there is no cursor / it is not in the list. */
function startFor(ids: readonly string[], cursorId: string | null): number {
  if (cursorId === null) return 0;
  const at = ids.indexOf(cursorId);
  return at >= 0 ? at + 1 : 0;
}

function emptySessionCostBundle(): SessionCostBundle {
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

/**
 * A query-level `whatIf` wins over the context-level one, so a single request can override the
 * session-wide simulation without the caller having to rebuild the context.
 */
function resolverFor(ctx: QueryContext, q: RangeQuery | undefined): PriceResolver {
  return createPriceResolver(ctx.pricing, parseWhatIf(q?.whatIf ?? ctx.whatIf));
}

function nowOf(ctx: QueryContext): Date {
  return ctx.now ?? new Date();
}

function sortValue(session: SessionSummary, sort: SessionSort): number | string {
  switch (sort) {
    case 'cost':
      return session.cost.total;
    case 'duration':
      return session.durationMs;
    case 'prompts':
      return session.promptCount;
    case 'requests':
      return session.requestCount;
    case 'tools':
      return session.toolCallCount;
    case 'started':
      return session.startedAt;
    case 'recent':
    default:
      return session.endedAt || session.startedAt;
  }
}

function compareSessions(a: SessionSummary, b: SessionSummary, sort: SessionSort, ascending: boolean): number {
  const va = sortValue(a, sort);
  const vb = sortValue(b, sort);
  let cmp = 0;
  if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
  else cmp = String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0;
  if (cmp === 0) cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return ascending ? cmp : -cmp;
}

function analyticsContext(db: DatabaseSync, q: RangeQuery, ctx: QueryContext): AnalyticsContext {
  const range = resolveRange(q, nowOf(ctx));
  const resolve = resolverFor(ctx, q);
  const scope = sessionScope({ ...q }, ctx.settings, { activeRange: range });
  return {
    db,
    scope,
    range,
    resolve,
    pricing: ctx.pricing,
    settings: ctx.settings,
    indexes: loadPriceIndexes(db, resolve, scope.sql, scope.params, ctx.pricing),
  };
}

class SqliteStore implements Store {
  private db: DatabaseSync;
  private closed = false;

  constructor(readonly dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /**
   * Drops the connection and opens a fresh one. Required after a full rebuild: the indexer runs
   * in a worker thread and drops/recreates every table, which leaves this connection's schema
   * cookie (and any statement it has cached) pointing at objects that no longer exist.
   */
  reopen(): void {
    if (this.closed) return;
    try {
      this.db.close();
    } catch {
      // Already closed by a concurrent shutdown; opening a new handle is still the right move.
    }
    this.db = openDatabase(this.dbPath);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async status(ctx: QueryContext): Promise<StoreStatus> {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row | undefined;
      return row ? num(row, 'n') : 0;
    };
    const models = (this.db.prepare('SELECT DISTINCT model FROM requests').all() as Row[]).map((row) =>
      str(row, 'model'),
    );
    let dbBytes = 0;
    try {
      dbBytes = statSync(this.dbPath).size;
    } catch {
      dbBytes = 0;
    }
    return {
      lastIndexedAt: getMeta(this.db, META_LAST_INDEXED_AT),
      dbBytes,
      counts: {
        projects: count('projects'),
        sessions: count('sessions'),
        requests: count('requests'),
        agents: count('agents'),
        messages: count('messages'),
      },
      unpricedModels: models.filter((model) => findModelPrice(model, ctx.pricing) === null).sort(),
      scratchSessions: this.scratchSessions(),
    };
  }

  /**
   * Sessions in a scratch project. The `projects` row is authoritative, with the same path-prefix
   * fallback `listProjects` uses so a session whose project row is missing is still classified.
   */
  private scratchSessions(): number {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(p.path, s.cwd, s.projectId) AS path, COALESCE(p.isScratch, 0) AS isScratch,
          COUNT(*) AS n
         FROM sessions s LEFT JOIN projects p ON p.id = s.projectId
         GROUP BY path, isScratch`,
      )
      .all() as Row[];
    let total = 0;
    for (const row of rows) {
      if (num(row, 'isScratch') !== 0 || isScratchPath(str(row, 'path'))) total += num(row, 'n');
    }
    return total;
  }

  /**
   * The project tree, priced over the same window every analytics route uses (missing bounds →
   * the last 30 days) so the rail cannot show all-time costs next to a 30-day footer.
   *
   * Every project is listed regardless of the range — a project with nothing in the window shows
   * `sessionCount: 0` / `totalCost: 0` rather than disappearing, so navigation never loses one.
   * `sessionCount` counts sessions with at least one request in the range, matching the overview's
   * "sessions with requests" KPI; `firstActivity` / `lastActivity` stay all-time, because they
   * describe the project rather than the window.
   */
  async listProjects(ctx: QueryContext, q: RangeQuery = {}): Promise<ProjectsResponse> {
    const resolve = resolverFor(ctx, q);
    const range = resolveRange(q, nowOf(ctx));
    const scope = sessionScope({ ...q }, ctx.settings, {});
    const inRangeScope = sessionScope({ ...q }, ctx.settings, { activeRange: range });
    const costs = loadSessionCosts(this.db, inRangeScope, resolve, ctx.pricing, range);
    const rows = this.db
      .prepare(
        `SELECT s.id AS id, s.projectId AS projectId, COALESCE(p.path, s.cwd, s.projectId) AS path,
          COALESCE(p.displayName, s.projectId) AS displayName, p.parentPath AS parentPath,
          COALESCE(p.isWorktree, 0) AS isWorktree, COALESCE(p.isScratch, 0) AS isScratch,
          s.startedAt AS startedAt, s.endedAt AS endedAt
         FROM sessions s${scope.sql}`,
      )
      .all(...scope.params) as Row[];

    const byProject = new Map<string, ProjectSummary>();
    for (const row of rows) {
      const id = str(row, 'projectId');
      const path = str(row, 'path');
      const summary = byProject.get(id) ?? {
        id,
        path,
        displayName: str(row, 'displayName'),
        isWorktree: num(row, 'isWorktree') !== 0 || worktreeParent(path) !== null,
        isScratch: num(row, 'isScratch') !== 0 || isScratchPath(path),
        sessionCount: 0,
        totalCost: 0,
        firstActivity: null,
        lastActivity: null,
      };
      const parentPath = optStr(row, 'parentPath') ?? worktreeParent(path);
      if (parentPath) summary.parentPath = parentPath;
      const bundle = costs.get(str(row, 'id'));
      if (bundle) {
        summary.sessionCount += 1;
        summary.totalCost += bundle.cost.total;
      }
      const startedAt = optStr(row, 'startedAt');
      const endedAt = optStr(row, 'endedAt');
      if (startedAt && (!summary.firstActivity || startedAt < summary.firstActivity)) {
        summary.firstActivity = startedAt;
      }
      if (endedAt && (!summary.lastActivity || endedAt > summary.lastActivity)) {
        summary.lastActivity = endedAt;
      }
      byProject.set(id, summary);
    }

    const all = [...byProject.values()];
    const byPath = new Map(all.map((project) => [project.path, project]));
    const roots: ProjectSummary[] = [];
    for (const project of all) {
      const parent = project.parentPath ? byPath.get(project.parentPath) : undefined;
      if (parent && parent !== project) {
        parent.children = [...(parent.children ?? []), project];
      } else {
        roots.push(project);
      }
    }
    const sortByCost = (list: ProjectSummary[]): void => {
      list.sort((a, b) => b.totalCost - a.totalCost);
      for (const project of list) if (project.children) sortByCost(project.children);
    };
    sortByCost(roots);
    return { projects: roots, totalCost: all.reduce((sum, p) => sum + p.totalCost, 0), range };
  }

  async listSessions(q: SessionsQuery, ctx: QueryContext): Promise<SessionsResponse> {
    const sessions = this.matchingSessions(q, ctx);
    const sort = q.sort ?? 'recent';
    const ascending = q.order === 'asc';
    sessions.sort((a, b) => compareSessions(a, b, sort, ascending));

    const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT));
    const cursorId = decodeCursor(q.cursor);
    let start = 0;
    if (cursorId) {
      const at = sessions.findIndex((s) => s.id === cursorId);
      start = at >= 0 ? at + 1 : 0;
    }
    const page = sessions.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      sessions: page,
      nextCursor: start + limit < sessions.length && last ? encodeCursor(last.id) : null,
      total: sessions.length,
      totalCost: sessions.reduce((sum, s) => sum + s.cost.total, 0),
    };
  }

  private matchingSessions(q: SessionsQuery, ctx: QueryContext): SessionSummary[] {
    const resolve = resolverFor(ctx, q);
    const range = q.from || q.to ? resolveRange(q, nowOf(ctx)) : undefined;
    const scope = sessionScope(q, ctx.settings, range ? { range } : {});
    const sessions = loadSessionSummaries(this.db, scope, resolve, ctx.pricing, ctx.settings);
    return q.pinned ? sessions.filter((s) => s.pinned) : sessions;
  }

  async getSession(sessionId: string, ctx: QueryContext): Promise<SessionDetail | null> {
    const resolve = resolverFor(ctx, {});
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s LEFT JOIN projects p ON p.id = s.projectId WHERE s.id = ?`)
      .get(sessionId) as Row | undefined;
    if (!row) return null;

    const scope = sessionScope({}, ctx.settings, { sessionIds: [sessionId], includeHidden: true });
    const bundle = loadSessionCosts(this.db, scope, resolve, ctx.pricing).get(sessionId) ?? emptySessionCostBundle();
    const summary = toSessionSummary(row, bundle, ctx.settings, str(row, 'projectPath'));
    const comparison = reportedComparisonOf(row, bundle);

    const indexes = loadSessionPriceIndexes(this.db, sessionId, resolve, ctx.pricing);
    const totals = loadAgentTotals(this.db, sessionId, resolve, ctx.pricing);
    const tree = buildAgentTree(this.db, sessionId, totals);
    const requests = loadRequestCosts(this.db, sessionId, MAIN_AGENT, resolve, ctx.pricing);
    const toolCalls = loadToolCalls(this.db, sessionId, indexes, tree);
    const injections = loadInjections(this.db, sessionId, indexes);
    const contextItems = loadContextItems(this.db, sessionId, indexes);
    const hooks = loadHookRuns(this.db, sessionId, injections);
    const compactions = loadCompactions(this.db, sessionId, resolve);
    const apiErrorRows = this.db
      .prepare('SELECT seq, ts, status, message FROM api_errors WHERE sessionId = ? ORDER BY seq')
      .all(sessionId) as Row[];

    return {
      summary,
      byModel: loadModelRows(this.db, sessionId, resolve, ctx.pricing),
      categories: buildCategories(summary.cost, toolCalls, injections, contextItems),
      turns: buildTurns(this.db, sessionId, requests, toolCalls, jsonColumn<number[]>(row, 'turnDurationsJson', [])),
      requests,
      toolCalls,
      injections,
      hooks,
      compactions,
      agents: tree.roots,
      workflowRuns: tree.workflowRuns,
      apiErrors: apiErrorRows.map((error) => {
        const out: SessionDetail['apiErrors'][number] = { seq: num(error, 'seq') };
        const ts = optStr(error, 'ts');
        if (ts) out.ts = ts;
        const status = nullableNum(error, 'status');
        if (status !== null) out.status = status;
        const message = optStr(error, 'message');
        if (message) out.message = message;
        return out;
      }),
      facts: {
        prLinks: jsonColumn(row, 'prLinksJson', []),
        localCommands: jsonColumn<string[]>(row, 'localCommandsJson', []),
        ...(optStr(row, 'permissionMode') ? { permissionMode: str(row, 'permissionMode') } : {}),
        chain: this.sessionChain(sessionId, resolve, ctx),
        ...(row['reportedJson'] ? { reported: jsonColumn(row, 'reportedJson', undefined) } : {}),
        ...(comparison ? { reportedComparison: comparison } : {}),
      },
      filePath: str(row, 'filePath'),
    };
  }

  /** Walks `continued-in` in both directions and prices each link. */
  private sessionChain(
    sessionId: string,
    resolve: PriceResolver,
    ctx: QueryContext,
  ): { sessionId: string; title: string; cost: number }[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    let backward: string | null = sessionId;
    while (backward && !seen.has(backward)) {
      seen.add(backward);
      ids.unshift(backward);
      const row = this.db.prepare('SELECT id FROM sessions WHERE continuedInSessionId = ?').get(backward) as
        | Row
        | undefined;
      backward = row ? str(row, 'id') : null;
    }
    let forward: string | null = sessionId;
    while (forward) {
      const row = this.db.prepare('SELECT continuedInSessionId FROM sessions WHERE id = ?').get(forward) as
        | Row
        | undefined;
      const next = row ? optStr(row, 'continuedInSessionId') : undefined;
      if (!next || seen.has(next)) break;
      seen.add(next);
      ids.push(next);
      forward = next;
    }
    if (ids.length <= 1) return [];
    const scope = sessionScope({}, ctx.settings, { sessionIds: ids, includeHidden: true });
    const costs = loadSessionCosts(this.db, scope, resolve, ctx.pricing);
    return ids.map((id) => {
      const row = this.db.prepare('SELECT title FROM sessions WHERE id = ?').get(id) as Row | undefined;
      return { sessionId: id, title: row ? str(row, 'title') : id, cost: costs.get(id)?.cost.total ?? 0 };
    });
  }

  async getTranscript(
    sessionId: string,
    agentId: string | null,
    fromSeq: number,
    limit: number,
    ctx: QueryContext,
  ): Promise<TranscriptPage | null> {
    const resolve = resolverFor(ctx, {});
    const requests = loadRequestCosts(this.db, sessionId, agentId ?? MAIN_AGENT, resolve, ctx.pricing);
    const bySeq = new Map(requests.map((request) => [request.seq, request]));
    return getTranscriptPage(this.db, sessionId, agentId, fromSeq, limit, bySeq);
  }

  async getAgentTree(sessionId: string, ctx: QueryContext): Promise<AgentTreeResponse | null> {
    const exists = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
    if (!exists) return null;
    const resolve = resolverFor(ctx, {});
    const totals = loadAgentTotals(this.db, sessionId, resolve, ctx.pricing);
    const tree = buildAgentTree(this.db, sessionId, totals);
    return { sessionId, agents: tree.roots, workflowRuns: tree.workflowRuns };
  }

  async search(q: SearchQuery, ctx: QueryContext): Promise<SearchResponse> {
    const started = Date.now();
    const scope = q.scope ?? 'everything';
    const limit = Math.max(1, Math.min(q.limit ?? 20, 100));
    const query = q.q.trim();
    if (query.length === 0) {
      return { query: q.q, scope, groups: [], nextCursor: null, totalSessions: 0, tookMs: 0 };
    }

    const scopeForIds = (ids: readonly string[]): SqlScope =>
      sessionScope({ ...q, q: undefined }, ctx.settings, { sessionIds: ids });
    /** Which of `ids` survive the project / model / scratch filters. Ids only — no aggregation. */
    const inScope = (ids: readonly string[]): Set<string> => {
      if (ids.length === 0) return new Set();
      const scoped = scopeForIds(ids);
      const rows = this.db
        .prepare(`SELECT s.id AS id FROM sessions s${scoped.sql}`)
        .all(...scoped.params) as Row[];
      return new Set(rows.map((row) => str(row, 'id')));
    };

    const cursorId = decodeCursor(q.cursor);
    let orderedIds: string[] = [];
    let hitsBySession = new Map<string, SearchSessionGroup['hits']>();
    // `hits` is capped at MAX_SEARCH_HITS_PER_SESSION for display; `hitCount` is the exact number
    // of hits in that session, counted without ranking, so the UI can say "3 of 12".
    let hitCounts = new Map<string, number>();
    let start = 0;
    if (scope === 'titles') {
      const ranked = searchTitles(this.db, query, TITLE_SCAN_LIMIT);
      const scoped = inScope(ranked);
      orderedIds = ranked.filter((id) => scoped.has(id));
      start = startFor(orderedIds, cursorId);
    } else {
      // The scan window is measured in hits, but paging is by session, so a query whose hits
      // concentrate in a handful of sessions used to fill the window without ever reaching a
      // second page — `nextCursor` came back null with most of the matches unseen. Widen the
      // window until it either proves there is no next page or stops being the binding limit.
      // Counting is cheap because it skips the ranking, so the exact matching-session set and
      // per-session hit totals are known up front and only the *order* needs the ranked scan.
      hitCounts = countContentHits(this.db, { ...q, q: query }, ctx.settings.hideScratchProjects);
      const scoped = inScope([...hitCounts.keys()]);
      for (const id of [...hitCounts.keys()]) if (!scoped.has(id)) hitCounts.delete(id);
      let window = Math.max(limit * HITS_PER_SESSION_ESTIMATE, MIN_HIT_SCAN);
      for (;;) {
        const hits = searchContent(this.db, { ...q, q: query }, ctx.settings.hideScratchProjects, window);
        orderedIds = [];
        hitsBySession = new Map();
        for (const { sessionId, hit } of hits) {
          if (!scoped.has(sessionId)) continue;
          const list = hitsBySession.get(sessionId);
          if (list) {
            if (list.length < MAX_SEARCH_HITS_PER_SESSION) list.push(hit);
          } else {
            hitsBySession.set(sessionId, [hit]);
            orderedIds.push(sessionId);
          }
        }
        start = startFor(orderedIds, cursorId);
        const truncated = hits.length >= window && orderedIds.length < hitCounts.size;
        const cursorPlaced = cursorId === null || orderedIds.includes(cursorId);
        const knowsNextPage = orderedIds.length > start + limit;
        if (!truncated || window >= MAX_HIT_SCAN || (cursorPlaced && knowsNextPage)) break;
        // Extrapolate from the hits-per-session this scan actually saw, so a deep page takes one
        // more scan rather than four; never shrink, and never below the plain growth factor.
        const wanted = start + limit + 1;
        const projected = Math.ceil((window * wanted) / Math.max(1, orderedIds.length));
        window = Math.min(Math.max(window * HIT_SCAN_GROWTH, projected), MAX_HIT_SCAN);
      }
    }

    const pageIds = orderedIds.slice(start, start + limit);
    const summaries = new Map<string, SessionSummary>();
    if (pageIds.length > 0) {
      for (const summary of loadSessionSummaries(
        this.db,
        scopeForIds(pageIds),
        resolverFor(ctx, q),
        ctx.pricing,
        ctx.settings,
      )) {
        summaries.set(summary.id, summary);
      }
    }
    const titleMatches = new Set(scope === 'titles' ? orderedIds : searchTitles(this.db, query, TITLE_SCAN_LIMIT));
    const groups: SearchSessionGroup[] = [];
    for (const id of pageIds) {
      const session = summaries.get(id);
      if (!session) continue;
      const hits = hitsBySession.get(id) ?? [];
      groups.push({
        session,
        hits,
        hitCount: hitCounts.get(id) ?? hits.length,
        titleMatch: titleMatches.has(id),
      });
    }
    const lastId = pageIds[pageIds.length - 1];
    return {
      query: q.q,
      scope,
      groups,
      nextCursor: start + limit < orderedIds.length && lastId ? encodeCursor(lastId) : null,
      totalSessions: scope === 'titles' ? orderedIds.length : hitCounts.size,
      tookMs: Date.now() - started,
    };
  }

  async overview(q: RangeQuery, ctx: QueryContext): Promise<OverviewResponse> {
    const analytics = analyticsContext(this.db, q, ctx);
    const byModel = modelRowsInRange(analytics);
    const { cost, tokens, requests } = totalsFromModelRows(byModel);
    const counts = rangeCounts(analytics);
    const daily = dailyPoints(analytics);

    // Range-scoped on purpose: the table is captioned "in the selected range", and whole-session
    // costs there could sum to more than the range total (182 % on a one-day window).
    const sessions = loadSessionSummaries(
      this.db,
      analytics.scope,
      analytics.resolve,
      ctx.pricing,
      ctx.settings,
      analytics.range,
    ).sort((a, b) => b.cost.total - a.cost.total);

    const projects = await this.listProjects(ctx, q);
    const flatProjects: ProjectSummary[] = [];
    const flatten = (list: readonly ProjectSummary[]): void => {
      for (const project of list) {
        flatProjects.push(project);
        if (project.children) flatten(project.children);
      }
    };
    flatten(projects.projects);
    const requestsByProject = requestCountsByProject(analytics);
    // `listProjects` lists every project so the rail keeps its navigation; the overview's spend
    // table only wants the ones that spent something in the window.
    const byProject = flatProjects
      .map((project) => ({
        project,
        cost: project.totalCost,
        sessions: project.sessionCount,
        requests: requestsByProject.get(project.id) ?? 0,
      }))
      .filter((row) => row.sessions > 0 || row.requests > 0 || row.cost !== 0)
      .sort((a, b) => b.cost - a.cost);

    const monthlyDaily = this.monthlyDaily(ctx, analytics.resolve, q);
    const insightsInput = buildInsightsInput(analytics, cost.total);

    return {
      range: analytics.range,
      totals: {
        cost,
        tokens,
        requests,
        sessions: counts.sessions,
        prompts: counts.prompts,
        toolCalls: counts.toolCalls,
        agents: counts.agents,
        cacheHitRatio: tokens.context > 0 ? tokens.cacheRead / tokens.context : 0,
        costPerPrompt: counts.prompts > 0 ? cost.total / counts.prompts : 0,
      },
      daily,
      byModel,
      byProject,
      byCategory: categoriesInRange(analytics, cost),
      topSessions: sessions.slice(0, TOP_SESSIONS),
      plan: planComparison(daily, ctx.settings),
      budget: budgetStatus(monthlyDaily, ctx.settings, nowOf(ctx)),
      insights: computeInsights(insightsInput, ctx).slice(0, 5),
      unpricedModels: (await this.status(ctx)).unpricedModels,
    };
  }

  /** Daily costs for the calendar month containing `now`, independent of the selected range. */
  private monthlyDaily(ctx: QueryContext, resolve: PriceResolver, q: RangeQuery): { date: string; cost: number }[] {
    const now = nowOf(ctx);
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const providerScope = sessionScope({ provider: q.provider }, ctx.settings, { includeHidden: true });
    const rows = this.db
      .prepare(
        `SELECT dateLocal, model, speed, serviceTier, inferenceGeo,
          SUM(input) AS input, SUM(output) AS output, SUM(cacheRead) AS cacheRead, SUM(cache5m) AS cache5m,
          SUM(cache1h) AS cache1h, SUM(cacheAssumed) AS cacheAssumed, SUM(thinking) AS thinking,
          SUM(webSearchRequests) AS webSearchRequests,
          SUM(webFetchRequests) AS webFetchRequests, contextTokens AS pricingContextTokens, SUM(contextTokens) AS contextTokens
         FROM requests WHERE dateLocal LIKE ? AND sessionId IN (SELECT s.id FROM sessions s${providerScope.sql})
         GROUP BY dateLocal, model, speed, serviceTier, inferenceGeo, contextTokens`,
      )
      .all(`${month}-%`, ...providerScope.params) as Row[];
    const byDate = new Map<string, number>();
    for (const row of rows) {
      const resolved = resolve(str(row, 'model'), flagsOf(row));
      const cost = costOfUsage(usageOf(row, ctx.pricing), resolved, ctx.pricing.webSearchPer1000).total;
      const date = str(row, 'dateLocal');
      byDate.set(date, (byDate.get(date) ?? 0) + cost);
    }
    return [...byDate.entries()].map(([date, cost]) => ({ date, cost }));
  }

  async toolsAnalytics(q: RangeQuery, ctx: QueryContext): Promise<ToolsAnalyticsResponse> {
    return toolsAnalytics(analyticsContext(this.db, q, ctx));
  }

  async modelsAnalytics(q: RangeQuery, ctx: QueryContext): Promise<ModelsAnalyticsResponse> {
    return modelsAnalytics(analyticsContext(this.db, q, ctx));
  }

  async hooksAnalytics(q: RangeQuery, ctx: QueryContext): Promise<HooksAnalyticsResponse> {
    return hooksAnalytics(analyticsContext(this.db, q, ctx));
  }

  async attributionAnalytics(q: RangeQuery, ctx: QueryContext): Promise<AttributionAnalyticsResponse> {
    return attributionAnalytics(analyticsContext(this.db, q, ctx));
  }

  async insights(q: RangeQuery, ctx: QueryContext): Promise<InsightsResponse> {
    const analytics = analyticsContext(this.db, q, ctx);
    const byModel = modelRowsInRange(analytics);
    const { cost } = totalsFromModelRows(byModel);
    return { range: analytics.range, insights: computeInsights(buildInsightsInput(analytics, cost.total), ctx) };
  }

  async exportSession(sessionId: string, ctx: QueryContext): Promise<SessionExport | null> {
    const detail = await this.getSession(sessionId, ctx);
    if (!detail) return null;
    const page = await this.getTranscript(sessionId, null, 0, 500, ctx);
    const transcript = page ? [...page.messages] : [];
    let next = page?.nextFromSeq ?? null;
    while (next !== null) {
      const more = await this.getTranscript(sessionId, null, next, 500, ctx);
      if (!more) break;
      transcript.push(...more.messages);
      next = more.nextFromSeq;
    }
    return { exportedAt: new Date().toISOString(), pricing: ctx.pricing, detail, transcript };
  }

  async exportSessionsCsv(q: SessionsQuery, ctx: QueryContext): Promise<string> {
    const sessions = this.matchingSessions(q, ctx);
    sessions.sort((a, b) => compareSessions(a, b, q.sort ?? 'recent', q.order === 'asc'));
    return sessionsToCsv(sessions);
  }
}

export function createStore(dbPath: string): Store {
  return new SqliteStore(dbPath);
}

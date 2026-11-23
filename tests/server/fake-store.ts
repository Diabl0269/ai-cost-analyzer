/**
 * In-memory `Store` used by every server test. Never touches the real DB — one fixed
 * synthetic session ("sess-1") is enough to exercise every route's happy path, 404 handling,
 * and CSV/JSON export shape.
 */
import type { Store, QueryContext, StoreStatus, StoreSummary } from '../../core/store.js';
import type {
  AgentTreeResponse,
  AttributionAnalyticsResponse,
  CostBreakdown,
  HooksAnalyticsResponse,
  InsightsResponse,
  ModelsAnalyticsResponse,
  OverviewResponse,
  ProjectsResponse,
  ProjectSummary,
  RangeQuery,
  SearchQuery,
  SearchResponse,
  SessionDetail,
  SessionExport,
  SessionSummary,
  SessionsQuery,
  SessionsResponse,
  SummaryPeriod,
  SummaryUsage,
  UsageCostStatus,
  ToolsAnalyticsResponse,
  TokenTotals,
  TranscriptPage,
  UserSettings,
} from '../../core/types.js';

export const FAKE_SESSION_ID = 'sess-1';

function zeroCost(): CostBreakdown {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 };
}

function zeroTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0, thinking: 0, webSearchRequests: 0, context: 0 };
}

function fakeSummary(id: string, pinnedIds: string[]): SessionSummary {
  return {
    id,
    projectId: 'proj-1',
    projectPath: '/home/user/project',
    title: 'Rename the helper in utils.ts',
    titleSource: 'first-prompt',
    firstPrompt: 'Rename the helper in utils.ts',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:05:00.000Z',
    durationMs: 300_000,
    activeMs: 300_000,
    models: ['claude-sonnet-5'],
    promptCount: 1,
    requestCount: 2,
    toolCallCount: 1,
    agentCount: 0,
    workflowRunCount: 0,
    compactionCount: 0,
    apiErrorCount: 0,
    hookRunCount: 0,
    tokens: zeroTokens(),
    cost: zeroCost(),
    costMain: 0,
    costAgents: 0,
    costWorkflows: 0,
    reportedCostUsd: null,
    pinned: pinnedIds.includes(id),
    unpriced: false,
  };
}

export class FakeStore implements Store {
  readonly dbPath = ':memory:';
  private pinnedIds: string[] = [];
  /** The context of the last per-session read, so tests can assert what routes threaded through. */
  lastSessionContext: QueryContext | null = null;

  status(_ctx: QueryContext): Promise<StoreStatus> {
    return Promise.resolve({
      lastIndexedAt: '2026-09-01T00:00:00.000Z',
      dbBytes: 4096,
      counts: { projects: 1, sessions: 1, requests: 2, agents: 0, messages: 4 },
      unpricedModels: [],
      scratchSessions: 5,
    });
  }

  /** Honours `hideScratchProjects` like the real store, so the status route's count is testable. */
  listProjects(ctx: QueryContext, _q?: RangeQuery): Promise<ProjectsResponse> {
    const projects: ProjectSummary[] = [
      {
        id: 'proj-1',
        path: '/home/user/project',
        displayName: 'project',
        isWorktree: false,
        isScratch: false,
        sessionCount: 1,
        totalCost: 0,
        firstActivity: '2026-09-01T10:00:00.000Z',
        lastActivity: '2026-09-01T10:05:00.000Z',
      },
      {
        id: 'proj-scratch',
        path: '/private/var/folders/zz/T/scratch',
        displayName: 'scratch',
        isWorktree: false,
        isScratch: true,
        sessionCount: 3,
        totalCost: 0,
        firstActivity: '2026-09-01T10:00:00.000Z',
        lastActivity: '2026-09-01T10:05:00.000Z',
        children: [
          {
            id: 'proj-scratch-wt',
            path: '/private/var/folders/zz/T/scratch/.worktree',
            displayName: 'scratch · worktree',
            isWorktree: true,
            isScratch: false,
            sessionCount: 2,
            totalCost: 0,
            firstActivity: '2026-09-01T10:00:00.000Z',
            lastActivity: '2026-09-01T10:05:00.000Z',
          },
        ],
      },
    ];
    return Promise.resolve({
      totalCost: 0,
      projects: ctx.settings.hideScratchProjects ? projects.filter((p) => !p.isScratch) : projects,
    });
  }

  listSessions(q: SessionsQuery, ctx: QueryContext): Promise<SessionsResponse> {
    void ctx;
    const sessions = [fakeSummary(FAKE_SESSION_ID, this.pinnedIds)].filter((s) =>
      q.pinned === undefined ? true : s.pinned === q.pinned,
    );
    return Promise.resolve({ sessions, nextCursor: null, total: sessions.length, totalCost: 0 });
  }

  getSession(sessionId: string, ctx: QueryContext): Promise<SessionDetail | null> {
    this.lastSessionContext = ctx;
    if (sessionId !== FAKE_SESSION_ID) return Promise.resolve(null);
    const detail: SessionDetail = {
      summary: fakeSummary(FAKE_SESSION_ID, this.pinnedIds),
      byModel: [],
      categories: {
        exact: zeroCost(),
        estimated: {
          assistantOutput: 0,
          userPrompts: 0,
          toolResultsByTool: [],
          hooks: 0,
          harness: 0,
          compactSummaries: 0,
          systemPrompt: 0,
          other: 0,
        },
      },
      turns: [],
      requests: [],
      toolCalls: [],
      injections: [],
      hooks: [],
      compactions: [],
      agents: [],
      workflowRuns: [],
      apiErrors: [],
      facts: { prLinks: [], localCommands: [], chain: [] },
      filePath: '/home/user/.claude/projects/-home-user-project/sess-1.jsonl',
    };
    return Promise.resolve(detail);
  }

  getTranscript(
    sessionId: string,
    _agentId: string | null,
    _fromSeq: number,
    _limit: number,
    ctx: QueryContext,
  ): Promise<TranscriptPage | null> {
    this.lastSessionContext = ctx;
    if (sessionId !== FAKE_SESSION_ID) return Promise.resolve(null);
    return Promise.resolve({ sessionId, agentId: null, messages: [], nextFromSeq: null, totalLines: 0 });
  }

  getAgentTree(sessionId: string, ctx: QueryContext): Promise<AgentTreeResponse | null> {
    this.lastSessionContext = ctx;
    if (sessionId !== FAKE_SESSION_ID) return Promise.resolve(null);
    return Promise.resolve({ sessionId, agents: [], workflowRuns: [] });
  }

  search(q: SearchQuery, _ctx: QueryContext): Promise<SearchResponse> {
    return Promise.resolve({
      query: q.q,
      scope: q.scope ?? 'everything',
      groups: [],
      nextCursor: null,
      totalSessions: 0,
      tookMs: 1,
    });
  }

  overview(_q: RangeQuery, _ctx: QueryContext): Promise<OverviewResponse> {
    return Promise.resolve({
      range: { from: '2026-09-01', to: '2026-09-07' },
      totals: {
        cost: zeroCost(),
        tokens: zeroTokens(),
        requests: 0,
        sessions: 0,
        prompts: 0,
        toolCalls: 0,
        agents: 0,
        cacheHitRatio: 0,
        costPerPrompt: 0,
      },
      daily: [],
      byModel: [],
      byProject: [],
      byCategory: {
        exact: zeroCost(),
        estimated: {
          assistantOutput: 0,
          userPrompts: 0,
          toolResultsByTool: [],
          hooks: 0,
          harness: 0,
          compactSummaries: 0,
          systemPrompt: 0,
          other: 0,
        },
      },
      topSessions: [],
      plan: { preset: 'none', label: 'None', monthlyUsd: 0, months: [] },
      budget: { monthlyBudgetUsd: null, month: '2026-09', spent: 0, forecast: 0, daysElapsed: 7, daysInMonth: 30 },
      insights: [],
      unpricedModels: [],
    });
  }

  summary(_ctx: QueryContext): Promise<StoreSummary> {
    const usage = (cost: number | null, status: UsageCostStatus): SummaryUsage => ({
      cost,
      costStatus: status,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      sessions: 0,
      unavailableSessions: 0,
      partialSessions: 0,
    });
    const period = (): SummaryPeriod => ({
      range: { from: '2026-09-07', to: '2026-09-07' },
      total: usage(0, 'recorded'),
      byProvider: {
        claude: usage(0, 'recorded'),
        codex: usage(null, 'unavailable'),
        copilot: usage(0, 'recorded'),
        opencode: usage(0, 'recorded'),
        gemini: usage(0, 'recorded'),
      },
    });
    return Promise.resolve({
      generatedAt: '2026-09-07T12:00:00.000Z',
      periods: { today: period(), week: period() },
      budget: { monthlyBudgetUsd: null, month: '2026-09', spent: 0, forecast: 0, daysElapsed: 7, daysInMonth: 30 },
    });
  }

  toolsAnalytics(_q: RangeQuery, _ctx: QueryContext): Promise<ToolsAnalyticsResponse> {
    return Promise.resolve({ range: { from: '2026-09-01', to: '2026-09-07' }, tools: [], total: 0 });
  }

  modelsAnalytics(_q: RangeQuery, _ctx: QueryContext): Promise<ModelsAnalyticsResponse> {
    return Promise.resolve({ range: { from: '2026-09-01', to: '2026-09-07' }, models: [], daily: [], bySpeed: [] });
  }

  hooksAnalytics(_q: RangeQuery, _ctx: QueryContext): Promise<HooksAnalyticsResponse> {
    return Promise.resolve({
      range: { from: '2026-09-01', to: '2026-09-07' },
      hooks: [],
      harness: [],
      totals: { hookEstCost: 0, harnessEstCost: 0, hookDurationMs: 0 },
    });
  }

  attributionAnalytics(_q: RangeQuery, _ctx: QueryContext): Promise<AttributionAnalyticsResponse> {
    return Promise.resolve({
      range: { from: '2026-09-01', to: '2026-09-07' },
      skills: [],
      plugins: [],
      mcpServers: [],
      localCommands: [],
    });
  }

  insights(_q: RangeQuery, _ctx: QueryContext): Promise<InsightsResponse> {
    return Promise.resolve({ range: { from: '2026-09-01', to: '2026-09-07' }, insights: [] });
  }

  async exportSession(sessionId: string, ctx: QueryContext): Promise<SessionExport | null> {
    const detail = await this.getSession(sessionId, ctx);
    if (!detail) return null;
    return { exportedAt: '2026-09-07T00:00:00.000Z', pricing: ctx.pricing, detail, transcript: [] };
  }

  exportSessionsCsv(_q: SessionsQuery, _ctx: QueryContext): Promise<string> {
    return Promise.resolve('id,title,cost\nsess-1,Rename the helper in utils.ts,0\n');
  }

  reopen(): void {
    // no-op: nothing to re-open; the real store drops and re-opens its SQLite connection here
  }

  close(): void {
    // no-op: nothing held open
  }

  /** test helper mirroring what ConfigStore.togglePin would do to settings.pinnedSessionIds */
  setPinned(pinned: string[]): void {
    this.pinnedIds = pinned;
  }
}

export function fakeSettingsWithPins(base: UserSettings, pinned: string[]): UserSettings {
  return { ...base, pinnedSessionIds: pinned };
}

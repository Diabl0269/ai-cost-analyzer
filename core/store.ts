/**
 * Store + indexer contract between core/db (implementer) and server (consumer).
 * Implemented in core/db/store.ts (createStore) and core/db/indexer.ts (runIndex, indexFiles).
 */
import type {
  AgentTreeResponse,
  AttributionAnalyticsResponse,
  DiscoveredSession,
  HooksAnalyticsResponse,
  IndexProgress,
  InsightsResponse,
  ModelsAnalyticsResponse,
  OverviewResponse,
  ParsedSession,
  PricingConfig,
  ProjectsResponse,
  RangeQuery,
  SearchQuery,
  SearchResponse,
  SessionDetail,
  SessionExport,
  SessionsQuery,
  SessionsResponse,
  ToolsAnalyticsResponse,
  TranscriptPage,
  UserSettings,
} from './types.js';

export interface QueryContext {
  pricing: PricingConfig;
  settings: UserSettings;
  /** injectable clock for tests */
  now?: Date;
  /** pricing overrides for what-if: `fromKey>toKey,fromKey>toKey` (same wire format as RangeQuery.whatIf) */
  whatIf?: string;
}

export interface StoreStatus {
  lastIndexedAt: string | null;
  dbBytes: number;
  counts: { projects: number; sessions: number; requests: number; agents: number; messages: number };
  /** raw model ids present in the DB that the pricing config cannot resolve */
  unpricedModels: string[];
  /**
   * How many of `counts.sessions` live in a scratch project (cwd under /tmp or
   * /private/var/folders) — i.e. how many `settings.hideScratchProjects` hides when it is on.
   * Always counted, over all time and independently of the setting, so the caller can decide
   * whether to surface it (`StatusResponse.scratchSessions`) without a second query.
   */
  scratchSessions: number;
}

export interface Store {
  readonly dbPath: string;
  status(ctx: QueryContext): Promise<StoreStatus>;
  listProjects(ctx: QueryContext, q?: RangeQuery): Promise<ProjectsResponse>;
  listSessions(q: SessionsQuery, ctx: QueryContext): Promise<SessionsResponse>;
  getSession(sessionId: string, ctx: QueryContext): Promise<SessionDetail | null>;
  getTranscript(
    sessionId: string,
    agentId: string | null,
    fromSeq: number,
    limit: number,
    ctx: QueryContext,
  ): Promise<TranscriptPage | null>;
  getAgentTree(sessionId: string, ctx: QueryContext): Promise<AgentTreeResponse | null>;
  search(q: SearchQuery, ctx: QueryContext): Promise<SearchResponse>;
  overview(q: RangeQuery, ctx: QueryContext): Promise<OverviewResponse>;
  toolsAnalytics(q: RangeQuery, ctx: QueryContext): Promise<ToolsAnalyticsResponse>;
  modelsAnalytics(q: RangeQuery, ctx: QueryContext): Promise<ModelsAnalyticsResponse>;
  hooksAnalytics(q: RangeQuery, ctx: QueryContext): Promise<HooksAnalyticsResponse>;
  attributionAnalytics(q: RangeQuery, ctx: QueryContext): Promise<AttributionAnalyticsResponse>;
  insights(q: RangeQuery, ctx: QueryContext): Promise<InsightsResponse>;
  exportSession(sessionId: string, ctx: QueryContext): Promise<SessionExport | null>;
  /** CSV rows for the sessions matching q (same semantics as listSessions, no paging) */
  exportSessionsCsv(q: SessionsQuery, ctx: QueryContext): Promise<string>;
  /** Re-open the underlying connection (required after a full rebuild recreates the schema). */
  reopen(): void;
  close(): void;
}

export interface IndexResult {
  sessionsIndexed: number;
  sessionsSkipped: number;
  filesSeen: number;
  parseErrors: number;
  /** Whole sessions that could not be parsed, distinct from tolerated malformed lines. */
  sessionsFailed?: number;
  durationMs: number;
  changedSessionIds: string[];
}

export interface IndexerDeps {
  /** default: core/discover.ts discoverSessions */
  discover?: (roots: string[]) => Promise<DiscoveredSession[]>;
  /** default: core/parse parseSession */
  parse?: (s: DiscoveredSession) => Promise<ParsedSession>;
}

export interface IndexerOptions extends IndexerDeps {
  roots: string[];
  dbPath: string;
  /** drop everything and rebuild */
  full?: boolean;
  onProgress?: (p: IndexProgress) => void;
  signal?: AbortSignal;
}

/** Full or incremental (mtime/size based) index of all roots. */
export type RunIndex = (opts: IndexerOptions) => Promise<IndexResult>;

/** Re-index only the sessions that own the given changed file paths (watcher path). */
export type IndexChangedFiles = (paths: string[], opts: IndexerOptions) => Promise<IndexResult>;

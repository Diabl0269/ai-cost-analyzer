/**
 * Shared contract for AI Cost Analyzer.
 * Domain types (parser → cost engine → db) and API types (server → web).
 * Contributors may APPEND fields/types; never rename or remove one without a deliberate migration.
 */

// ───────────────────────────── Discovery ─────────────────────────────

export type Provider = 'claude' | 'codex';

export type TranscriptKind = 'main' | 'subagent' | 'workflow-agent';

export interface DiscoveredFile {
  provider?: 'claude' | 'codex';
  path: string;
  size: number;
  mtimeMs: number;
  kind: TranscriptKind;
  projectDirName: string;
  sessionId: string;
  /** agent id for subagent / workflow-agent files (from filename `agent-<id>.jsonl`) */
  agentId?: string;
  /** workflow run id for workflow-agent files (`wf_…`) */
  runId?: string;
  /** sibling `agent-<id>.meta.json` if present */
  metaPath?: string;
}

export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  parentAgentId?: string;
  spawnDepth?: number;
  /** requested model alias, e.g. "sonnet", "haiku", or full id */
  model?: string;
}

export interface DiscoveredWorkflowRun {
  runId: string;
  dir: string;
  journalPath?: string;
  agentFiles: DiscoveredFile[];
}

export interface DiscoveredSession {
  provider?: 'claude' | 'codex';
  projectDirName: string;
  projectDirPath: string;
  sessionId: string;
  mainFile: DiscoveredFile;
  agentFiles: DiscoveredFile[];
  workflowRuns: DiscoveredWorkflowRun[];
  customTitlePath?: string;
  /** entry from sessions-index.json if present */
  indexEntry?: SessionsIndexEntry;
}

export interface SessionsIndexEntry {
  sessionId: string;
  fullPath?: string;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
}

// ───────────────────────────── Parsed transcript ─────────────────────────────

export type TokenClass = 'input' | 'output' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheRead';

/** Normalized token usage for one billed unit. Integers. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
  /** subset of `output`, from output_tokens_details.thinking_tokens (0 when absent) */
  thinking: number;
  webSearchRequests: number;
  webFetchRequests: number;
  /** true when cache_creation breakdown was absent and cache_creation_input_tokens was assumed 5m/1h */
  assumedTtl?: boolean;
}

export type Speed = 'standard' | 'fast';
export type ServiceTier = 'standard' | 'priority' | 'batch';
export type InferenceGeo = 'global' | 'us';

export interface BilledIteration {
  model: string;
  usage: TokenUsage;
  /** 'message' | 'fallback_message' | other */
  type: string;
}

export type BlockType = 'thinking' | 'text' | 'tool_use' | 'fallback' | 'other';

export interface ParsedBlock {
  type: BlockType;
  /** serialized length used for output-share attribution */
  chars: number;
  toolUseId?: string;
  toolName?: string;
}

export interface Attribution {
  skill?: string;
  plugin?: string;
  mcpServer?: string;
  mcpTool?: string;
}

export interface ByteRange {
  byteOffset: number;
  byteLength: number;
}

/** One billed API call (deduplicated assistant message). */
export interface ParsedRequest {
  /** line index (0-based) of the FIRST line of this message in the file */
  seq: number;
  turnIndex: number;
  messageId: string;
  requestId?: string;
  uuid: string;
  parentUuid?: string | null;
  ts: string;
  model: string;
  usage: TokenUsage;
  /** present only when message.usage.iterations had length > 1 */
  iterations?: BilledIteration[];
  speed: Speed;
  serviceTier: ServiceTier;
  inferenceGeo: InferenceGeo;
  stopReason?: string;
  blocks: ParsedBlock[];
  isSynthetic: boolean;
  isApiError: boolean;
  isAbortedMidStream: boolean;
  isFallback: boolean;
  effort?: string;
  attribution: Attribution;
  /** all JSONL lines that make up this message, in apiBlockIndex order */
  lines: ByteRange[];
  /** input + cacheRead + cache5m + cache1h */
  contextTokens: number;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'attachment';
export type MessageKind =
  | 'prompt'
  | 'tool_result'
  | 'compact_summary'
  | 'meta'
  | 'interrupt'
  | 'assistant'
  | 'system'
  | 'attachment';

/** One transcript line worth showing / searching. */
export interface ParsedMessage {
  seq: number;
  turnIndex: number;
  uuid: string;
  parentUuid?: string | null;
  ts?: string;
  role: MessageRole;
  kind: MessageKind;
  /** for assistant lines */
  messageId?: string;
  /** seq of the ParsedRequest this line belongs to (assistant lines) */
  requestSeq?: number;
  /** system subtype or attachment type */
  subtype?: string;
  range: ByteRange;
  /** text indexed for search (may be empty) */
  searchText: string;
  /** first 240 chars of human-visible text */
  preview: string;
  isMeta: boolean;
  isSidechain: boolean;
}

export type ToolResultShape = 'string' | 'text' | 'image' | 'mixed' | 'tool_reference' | 'missing';

export interface ParsedToolCall {
  toolUseId: string;
  name: string;
  /** for mcp__<server>__<tool> */
  mcpServer?: string;
  mcpTool?: string;
  /** seq of the request that emitted the tool_use */
  requestSeq: number;
  turnIndex: number;
  ts: string;
  /** JSON.stringify(input).length */
  inputChars: number;
  /** short human summary of input (command, file path, description…) ≤ 160 chars */
  inputSummary: string;
  /** seq of the user line carrying the tool_result (undefined if never answered) */
  resultSeq?: number;
  resultChars: number;
  resultImages: number;
  resultShape: ToolResultShape;
  isError: boolean;
  /** first 240 chars of the result text */
  resultPreview: string;
  /** Agent tool: linked agent id (from toolUseResult.agentId or meta.toolUseId) */
  childAgentId?: string;
  /** Workflow tool: linked run id */
  childRunId?: string;
  /** Agent tool: model requested / resolved */
  childModel?: string;
  childDescription?: string;
  /** Bash etc.: wall time if recorded */
  durationMs?: number;
  /** attachment/hook context that was injected as part of this tool result line */
  persistedOutputPath?: string;
}

export type InjectionKind =
  | 'user_prompt'
  | 'hook_context'
  | 'hook_blocking'
  | 'hook_stdout'
  | 'attachment'
  | 'compact_summary'
  | 'system_prompt'
  | 'other';

export interface ParsedInjection {
  seq: number;
  turnIndex: number;
  ts?: string;
  kind: InjectionKind;
  /** attachment.type, hookName, or 'prompt' */
  name: string;
  chars: number;
  /** related hook run id or tool use id when applicable */
  hookName?: string;
  hookEvent?: string;
  /** whether `rendered` was present (exact chars) or chars were derived */
  charsSource: 'rendered' | 'content' | 'json' | 'none';
}

export type HookRecordKind = 'success' | 'blocking_error' | 'cancelled' | 'stop_summary' | 'additional_context';

export interface ParsedHookRun {
  seq: number;
  turnIndex: number;
  ts?: string;
  kind: HookRecordKind;
  hookName?: string;
  hookEvent?: string;
  command?: string;
  durationMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  hookCount?: number;
  errorCount?: number;
  injectedChars: number;
}

export interface ParsedCompaction {
  seq: number;
  turnIndex: number;
  ts?: string;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  cumulativeDroppedTokens?: number;
}

export interface ParsedApiError {
  seq: number;
  ts?: string;
  status?: number;
  message?: string;
  retryAttempt?: number;
  maxRetries?: number;
}

export interface TranscriptMeta {
  /** Assistant output exists in a turn with no reported billing usage. */
  usageIncomplete?: boolean;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  sessionKind?: string;
  slug?: string;
  /** most common effort value on assistant lines */
  effort?: string;
  /**
   * Cleaned first human prompt of THIS transcript (main or agent). `SessionFacts.firstPrompt`
   * carries the same value for main transcripts; agents need it to label rows whose `meta.json`
   * has no `description` (workflow agents).
   */
  firstPrompt?: string;
  firstTs?: string;
  lastTs?: string;
  lineCount: number;
  parseErrors: number;
}

export interface ReportedModelUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests?: number;
  costUSD: number;
}

/** From the last `cost-state` line. */
export interface ReportedCost {
  totalCostUSD: number;
  totalAPIDurationMs?: number;
  totalDurationMs?: number;
  totalToolDurationMs?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  hasUnknownModelCost?: boolean;
  modelUsage: Record<string, ReportedModelUsage>;
}

export type TitleSource =
  | 'custom-title'
  | 'custom-title-file'
  | 'ai-title'
  | 'agent-name'
  | 'sessions-index'
  | 'first-prompt'
  | 'slug'
  | 'session-id';

export interface SessionFacts {
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  firstPrompt?: string;
  reportedCost?: ReportedCost;
  prLinks: { url: string; number?: number; repository?: string; ts?: string }[];
  continuedInSessionId?: string;
  relocatedCwd?: string;
  permissionMode?: string;
  mode?: string;
  /** `<command-name>` values from local_command lines */
  localCommands: string[];
  queuedOperations: number;
  turnDurationsMs: number[];
  awaySummaries: number;
}

export interface ParsedTranscript {
  file: DiscoveredFile;
  /** null for the main transcript */
  agentId: string | null;
  meta: TranscriptMeta;
  requests: ParsedRequest[];
  messages: ParsedMessage[];
  toolCalls: ParsedToolCall[];
  injections: ParsedInjection[];
  hooks: ParsedHookRun[];
  compactions: ParsedCompaction[];
  apiErrors: ParsedApiError[];
  /** number of human prompts (turns) */
  promptCount: number;
  /** only for main transcripts */
  facts?: SessionFacts;
  /** legacy: sidechain groups discovered inside this file, keyed by agentId */
  embeddedAgents?: Record<string, ParsedTranscript>;
}

export interface ParsedWorkflowRun {
  runId: string;
  dir: string;
  agents: ParsedTranscript[];
  /** from journal.jsonl */
  journal: { started: number; result: number; failed: number };
}

export interface ParsedSession {
  discovered: DiscoveredSession;
  main: ParsedTranscript;
  agents: ParsedTranscript[];
  agentMeta: Record<string, AgentMeta>;
  workflowRuns: ParsedWorkflowRun[];
  customTitleFromFile?: string;
}

// ───────────────────────────── Pricing ─────────────────────────────

/** USD per million tokens. */
export interface TokenPrices {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelPrice extends TokenPrices {
  /** stable key, e.g. "opus-5" */
  key: string;
  label: string;
  /** model-id prefixes matched after normalization; longest match wins */
  match: string[];
  /** when true, `match` entries must equal the normalized id exactly */
  exact?: boolean;
  /** fast-mode prices when the model supports speed:"fast" */
  fast?: TokenPrices;
  /** Full-request API premium when input context exceeds this token threshold. */
  longContext?: { threshold: number; inputMultiplier: number; outputMultiplier: number };
  supportsUsGeo: boolean;
  /** heuristic characters per token for this tokenizer generation */
  charsPerToken: number;
  /** family for color coding */
  family: ModelFamily;
  retired?: boolean;
  /** true when added by the user (not from defaults) */
  custom?: boolean;
}

export type ModelFamily = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku' | 'synthetic' | 'other';

export interface PricingConfig {
  version: 1;
  updatedAt: string;
  source: string;
  models: ModelPrice[];
  webSearchPer1000: number;
  usGeoMultiplier: number;
  batchMultiplier: number;
  unknownModelPolicy: 'zero' | 'fallbackModel';
  fallbackModelKey?: string;
  assumeCacheWriteTtlWhenUnknown: '5m' | '1h';
}

/** Resolved per-token prices (USD per token) for one billed unit. */
export interface ResolvedPrice {
  modelKey: string | null;
  label: string;
  family: ModelFamily;
  perToken: TokenPrices;
  charsPerToken: number;
  unpriced: boolean;
  multipliers: { fast: boolean; usGeo: boolean; batch: boolean };
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  webSearch: number;
  total: number;
}

// ───────────────────────────── Settings ─────────────────────────────

export type PlanPreset = 'none' | 'pro' | 'max5' | 'max20' | 'team-premium' | 'custom';

export interface UserSettings {
  version: 1;
  roots: string[];
  theme: 'system' | 'paper' | 'slate';
  plan: { preset: PlanPreset; monthlyUsd: number; label: string };
  monthlyBudgetUsd: number | null;
  currency: { code: string; rate: number };
  pinnedSessionIds: string[];
  /** hide the tmp scratch project (cwd under /private/var/folders or /tmp) by default */
  hideScratchProjects: boolean;
  reducedMotion: 'system' | 'on' | 'off';
}

// ───────────────────────────── API ─────────────────────────────

export interface RangeQuery {
  /** Omitted means all providers. */
  provider?: Provider;
  /** ISO date (YYYY-MM-DD) inclusive, local time */
  from?: string;
  to?: string;
  project?: string;
  /** pricing overrides for what-if: modelKey → substitute modelKey */
  whatIf?: string;
}

export interface StatusResponse {
  /** Retained failure: totals may be incomplete until a full rebuild or rescan succeeds. */
  indexError?: string;
  version: string;
  indexing: boolean;
  progress?: IndexProgress;
  lastIndexedAt: string | null;
  roots: string[];
  dbPath: string;
  dbBytes: number;
  counts: { projects: number; sessions: number; requests: number; agents: number; messages: number };
  unpricedModels: string[];
  /**
   * How many of `counts.sessions` live in a scratch project (cwd under /tmp or
   * /private/var/folders). Only present while `settings.hideScratchProjects` is on, i.e. while
   * those sessions are actually being hidden from the lists — the UI shows
   * "477 indexed · 337 scratch hidden" so the gap is never a mystery.
   */
  scratchSessions?: number;
}

export interface IndexProgress {
  phase: 'discover' | 'parse' | 'write' | 'done' | 'error';
  filesDone: number;
  filesTotal: number;
  sessionsDone: number;
  sessionsTotal: number;
  currentProject?: string;
  startedAt: string;
  message?: string;
}

export type IndexEvent =
  | { type: 'progress'; progress: IndexProgress }
  | { type: 'sessionsChanged'; sessionIds: string[] }
  | { type: 'indexed'; at: string; indexError?: string }
  | { type: 'error'; message: string }
  | { type: 'ping' };

export interface ProjectSummary {
  id: string;
  path: string;
  displayName: string;
  parentPath?: string;
  isWorktree: boolean;
  isScratch: boolean;
  sessionCount: number;
  totalCost: number;
  firstActivity: string | null;
  lastActivity: string | null;
  children?: ProjectSummary[];
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
  totalCost: number;
  /**
   * The range `sessionCount` and `totalCost` were measured over, resolved exactly like the
   * analytics routes (missing bounds → the last 30 days). Every project is still listed, with
   * zeros when it had no request in the range, so navigation never loses one.
   */
  range?: { from: string; to: string };
}

export type SessionSort = 'recent' | 'cost' | 'duration' | 'prompts' | 'requests' | 'tools' | 'started';

export interface SessionsQuery extends RangeQuery {
  q?: string;
  sort?: SessionSort;
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  model?: string;
  entrypoint?: string;
  pinned?: boolean;
  hasAgents?: boolean;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
  thinking: number;
  webSearchRequests: number;
  context: number;
}

export interface ModelCostRow {
  model: string;
  modelKey: string | null;
  label: string;
  family: ModelFamily;
  requests: number;
  tokens: TokenTotals;
  cost: CostBreakdown;
  unpriced: boolean;
}

export interface SessionSummary {
  /** Recorded usage is incomplete; costs cover recorded tokens only. */
  usageIncomplete?: boolean;
  provider?: Provider;
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  titleSource: TitleSource;
  firstPrompt: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  activeMs: number;
  entrypoint?: string;
  sessionKind?: string;
  gitBranch?: string;
  version?: string;
  effort?: string;
  models: string[];
  promptCount: number;
  requestCount: number;
  toolCallCount: number;
  agentCount: number;
  workflowRunCount: number;
  compactionCount: number;
  apiErrorCount: number;
  hookRunCount: number;
  tokens: TokenTotals;
  cost: CostBreakdown;
  /** cost of main transcript vs delegated */
  costMain: number;
  costAgents: number;
  costWorkflows: number;
  reportedCostUsd: number | null;
  /** how our token counts line up with Claude Code's own tally; absent when it has no tally */
  reportedStatus?: ReportedComparisonStatus;
  pinned: boolean;
  continuedInSessionId?: string;
  unpriced: boolean;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  nextCursor: string | null;
  total: number;
  totalCost: number;
}

export interface RequestCost {
  seq: number;
  turnIndex: number;
  ts: string;
  model: string;
  modelKey: string | null;
  family: ModelFamily;
  usage: TokenUsage;
  contextTokens: number;
  cost: CostBreakdown;
  cacheHitRatio: number;
  coldCache: boolean;
  speed: Speed;
  stopReason?: string;
  isFallback: boolean;
  unpriced: boolean;
  attribution: Attribution;
  toolNames: string[];
}

export type EstMethod = 'delta' | 'heuristic' | 'image' | 'none';

export interface AttributedCost {
  tokens: number;
  estMethod: EstMethod;
  ingestCost: number;
  carryCost: number;
  /** number of later requests that carried this content */
  carryRequests: number;
}

export interface ToolCallCost {
  toolUseId: string;
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
  /** share of the emitting request's output */
  genTokens: number;
  genCost: number;
  result: AttributedCost;
  /** genCost + result.ingestCost + result.carryCost */
  ownCost: number;
  childAgentId?: string;
  childRunId?: string;
  childCost: number | null;
  childModel?: string;
  childDescription?: string;
}

export interface InjectionCost {
  seq: number;
  agentId: string | null;
  turnIndex: number;
  kind: InjectionKind;
  name: string;
  chars: number;
  cost: AttributedCost;
  hookName?: string;
  hookEvent?: string;
}

export interface HookRunRow {
  seq: number;
  agentId: string | null;
  turnIndex: number;
  ts?: string;
  kind: HookRecordKind;
  hookName?: string;
  hookEvent?: string;
  command?: string;
  durationMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  injectedChars: number;
  estCost: number;
}

export interface CompactionRow {
  seq: number;
  agentId: string | null;
  turnIndex: number;
  ts?: string;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  rewarmCost: number;
}

export interface AgentNode {
  agentId: string;
  runId?: string;
  parentAgentId?: string;
  parentToolUseId?: string;
  agentType?: string;
  description?: string;
  requestedModel?: string;
  models: string[];
  spawnDepth: number;
  startedAt?: string;
  endedAt?: string;
  requestCount: number;
  toolCallCount: number;
  tokens: TokenTotals;
  cost: CostBreakdown;
  children: AgentNode[];
}

export interface WorkflowRunNode {
  runId: string;
  toolUseId?: string;
  agentCount: number;
  cost: CostBreakdown;
  journal: { started: number; result: number; failed: number };
  agents: AgentNode[];
}

export interface TurnSummary {
  turnIndex: number;
  startSeq: number;
  ts: string;
  promptPreview: string;
  requestCount: number;
  toolCallCount: number;
  cost: number;
  durationMs?: number;
}

export interface CategoryShare {
  /** exact split */
  exact: CostBreakdown;
  /** estimated split of context cost by what filled it */
  estimated: {
    assistantOutput: number;
    userPrompts: number;
    toolResultsByTool: { name: string; cost: number; calls: number }[];
    hooks: number;
    harness: number;
    compactSummaries: number;
    systemPrompt: number;
    other: number;
    /** ingest + carry of the assistant's own earlier replies, re-sent as history (METHODOLOGY §3) */
    assistantHistory?: number;
    /** ingest + carry of the baseline context floor: system prompt, tool defs, memory, skills */
    baseline?: number;
  };
}

export interface SessionDetail {
  summary: SessionSummary;
  byModel: ModelCostRow[];
  categories: CategoryShare;
  turns: TurnSummary[];
  requests: RequestCost[];
  toolCalls: ToolCallCost[];
  injections: InjectionCost[];
  hooks: HookRunRow[];
  compactions: CompactionRow[];
  agents: AgentNode[];
  workflowRuns: WorkflowRunNode[];
  apiErrors: { seq: number; ts?: string; status?: number; message?: string }[];
  facts: {
    prLinks: SessionFacts['prLinks'];
    localCommands: string[];
    permissionMode?: string;
    chain: { sessionId: string; title: string; cost: number }[];
    reported?: ReportedCost;
    /** per-class and USD deltas against `reported`; absent when there is no `cost-state` line */
    reportedComparison?: ReportedComparison;
  };
  filePath: string;
}

export type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; text: string; images: number; isError: boolean }
  | { type: 'image'; count: number }
  | { type: 'other'; label: string };

export interface TranscriptMessage {
  seq: number;
  turnIndex: number;
  uuid: string;
  ts?: string;
  role: MessageRole;
  kind: MessageKind;
  subtype?: string;
  messageId?: string;
  requestSeq?: number;
  blocks: TranscriptBlock[];
  /** request cost when this line starts a request */
  request?: RequestCost;
  isMeta: boolean;
}

export interface TranscriptPage {
  sessionId: string;
  agentId: string | null;
  messages: TranscriptMessage[];
  nextFromSeq: number | null;
  totalLines: number;
}

export interface AgentTreeResponse {
  sessionId: string;
  agents: AgentNode[];
  workflowRuns: WorkflowRunNode[];
}

export type SearchScope = 'titles' | 'everything';
export type SearchKind = 'prompt' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result';

export interface SearchQuery extends RangeQuery {
  q: string;
  scope?: SearchScope;
  kinds?: SearchKind[];
  model?: string;
  tool?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchHit {
  seq: number;
  agentId: string | null;
  kind: MessageKind;
  ts?: string;
  /** snippet with <mark>…</mark> around matches (HTML-escaped otherwise) */
  snippet: string;
  score: number;
}

export interface SearchSessionGroup {
  session: SessionSummary;
  /** the best few hits, capped for display */
  hits: SearchHit[];
  /** every hit the scan found in this session, not just the ones in `hits` */
  hitCount: number;
  titleMatch: boolean;
}

export interface SearchResponse {
  query: string;
  scope: SearchScope;
  groups: SearchSessionGroup[];
  nextCursor: string | null;
  totalSessions: number;
  tookMs: number;
}

export interface DailyPoint {
  date: string;
  cost: number;
  requests: number;
  sessions: number;
  tokens: TokenTotals;
}

export interface PlanComparison {
  preset: PlanPreset;
  label: string;
  monthlyUsd: number;
  months: { month: string; apiCost: number; planCost: number; delta: number }[];
}

export interface BudgetStatus {
  monthlyBudgetUsd: number | null;
  month: string;
  spent: number;
  forecast: number;
  daysElapsed: number;
  daysInMonth: number;
}

export interface Insight {
  id: string;
  title: string;
  explanation: string;
  impactUsd: number;
  kind: 'saving' | 'waste' | 'info';
  sessions: { sessionId: string; title: string; amount: number }[];
  metric?: { label: string; value: string };
}

export interface OverviewResponse {
  /** Incomplete transcripts with activity in the selected provider/project/date scope. */
  usageCoverage?: { unavailableSessions: number; partialSessions: number };
  range: { from: string; to: string };
  totals: {
    cost: CostBreakdown;
    tokens: TokenTotals;
    requests: number;
    sessions: number;
    prompts: number;
    toolCalls: number;
    agents: number;
    cacheHitRatio: number;
    costPerPrompt: number;
  };
  daily: DailyPoint[];
  byModel: ModelCostRow[];
  byProject: { project: ProjectSummary; cost: number; sessions: number; requests: number }[];
  byCategory: CategoryShare;
  topSessions: SessionSummary[];
  plan: PlanComparison;
  budget: BudgetStatus;
  insights: Insight[];
  unpricedModels: string[];
}

export interface ToolAnalyticsRow {
  name: string;
  mcpServer?: string;
  calls: number;
  errors: number;
  sessions: number;
  avgResultChars: number;
  totalResultTokens: number;
  genCost: number;
  ingestCost: number;
  carryCost: number;
  totalCost: number;
  childCost: number;
}

export interface ToolsAnalyticsResponse {
  range: { from: string; to: string };
  tools: ToolAnalyticsRow[];
  total: number;
}

export interface ModelsAnalyticsResponse {
  range: { from: string; to: string };
  models: ModelCostRow[];
  daily: { date: string; byModel: Record<string, number> }[];
  bySpeed: { speed: Speed; requests: number; cost: number }[];
}

export interface HookAnalyticsRow {
  hookName: string;
  /** Presentable label: same as `hookName` when the transcript reported one, otherwise the hook
   * event plus a short command-derived label (e.g. "Stop · notify-stop.sh") instead of the raw
   * `(unnamed)` placeholder still carried in `hookName` for back-compat. */
  displayName: string;
  hookEvent?: string;
  /** First/representative shell command behind this row, when the transcript reported one. */
  command?: string;
  runs: number;
  failures: number;
  timeouts: number;
  totalDurationMs: number;
  avgDurationMs: number;
  injectedChars: number;
  estCost: number;
}

export interface HarnessAnalyticsRow {
  attachmentType: string;
  occurrences: number;
  chars: number;
  estCost: number;
}

export interface HooksAnalyticsResponse {
  range: { from: string; to: string };
  hooks: HookAnalyticsRow[];
  harness: HarnessAnalyticsRow[];
  totals: { hookEstCost: number; harnessEstCost: number; hookDurationMs: number };
}

export interface AttributionAnalyticsResponse {
  range: { from: string; to: string };
  skills: { name: string; requests: number; cost: number }[];
  plugins: { name: string; requests: number; cost: number }[];
  mcpServers: { name: string; requests: number; cost: number; toolCalls: number }[];
  localCommands: { name: string; uses: number }[];
}

export interface InsightsResponse {
  range: { from: string; to: string };
  insights: Insight[];
}

export interface SessionExport {
  exportedAt: string;
  pricing: PricingConfig;
  detail: SessionDetail;
  transcript: TranscriptMessage[];
}

export interface ApiError {
  error: { code: string; message: string };
}

// ─────────────── Attribution facts (core/cost/attribution.ts, appended by core-cost-index) ───────────────

/** How one request's `output_tokens` were split across its content blocks. */
export interface OutputShare {
  thinkingTokens: number;
  textTokens: number;
  /** tool_use block id → its share of the non-thinking output tokens */
  toolUseTokens: Map<string, number>;
}

/**
 * One price-independent attribution fact: a piece of content that entered the model's context.
 * Money is derived at read time from `ingestRequestSeq` / `lastCarrySeq` and current pricing.
 */
export interface AttributedItem {
  kind: 'tool_result' | InjectionKind | ContextItemKind;
  /** tool_use id for tool results, transcript seq for injections, `kind:seq` for context items */
  ref: string | number;
  /** seq of the transcript line carrying this content */
  seq: number;
  chars: number;
  tokens: number;
  estMethod: ContextEstMethod;
  /** seq of the request that first sent this content (null = never ingested) */
  ingestRequestSeq: number | null;
  /** seq of the last request that re-sent it (null = never carried) */
  lastCarrySeq: number | null;
  turnIndex: number;
}

export interface TranscriptAttribution {
  /** keyed by request seq */
  outputShares: Map<number, OutputShare>;
  items: AttributedItem[];
}

// ─────────── Reported-tally comparison (core/cost/reported.ts) ───────────

/**
 * How this session's own token counts line up with Claude Code's `cost-state` tally.
 * The two disagree for structural reasons, not arithmetic ones — see docs/METHODOLOGY.md §2.
 */
export type ReportedComparisonStatus =
  /** every token class agrees within 5%; the USD totals then agree too */
  | 'match'
  /** the tally is larger: it was inherited from a parent process (/fork, continuation, resume) */
  | 'tally-includes-earlier-process'
  /** the file is larger: the tally reset on resume while the file kept the whole history */
  | 'file-covers-more-than-tally'
  /** nothing billed in the file, a small tally: background calls such as title generation */
  | 'hidden-calls-only'
  /** classes disagree in both directions */
  | 'mixed';

/**
 * Signed percentage deltas of *our* numbers against Claude Code's reported tally: positive means
 * we counted more than it did. Each delta is normalised by the larger of the two values, so it
 * stays in [-100, +100] and is defined when one side is zero.
 */
export interface ReportedComparison {
  status: ReportedComparisonStatus;
  /** USD: (computed − reported) as a percentage */
  deltaPct: number;
  classes: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// ───────── Whole-context attribution (core/cost/attribution.ts, appended by cost-model fixer) ─────────

/**
 * Context that is not a discrete injection or tool result, but is nonetheless re-sent on every
 * request: the assistant's own earlier replies and the baseline floor of the context window.
 * See docs/METHODOLOGY.md §3 "Re-sent history and baseline context".
 */
export type ContextItemKind =
  /** one per request: that reply's own output tokens, ingested by the next request */
  | 'assistant_history'
  /** the context present at the first request: system prompt, tool defs, CLAUDE.md, skills */
  | 'baseline'
  /** what survived a compaction on top of the baseline and the summary */
  | 'post_compaction_floor';

/** `EstMethod` plus the one method only context items use: the exact reported output count. */
export type ContextEstMethod = EstMethod | 'exact-output';

/** A priced {@link ContextItemKind} item. Context items have no generation cost of their own. */
export interface ContextItemCost {
  seq: number;
  agentId: string | null;
  turnIndex: number;
  kind: ContextItemKind;
  tokens: number;
  estMethod: ContextEstMethod;
  ingestCost: number;
  carryCost: number;
  /** number of later requests that re-sent this content */
  carryRequests: number;
}

/**
 * SQLite schema for the index (SPEC §6).
 *
 * Two rules shape every table here:
 *  - tokens are stored as integers, money is never stored — it is computed at read time so that
 *    editing the pricing table or running a what-if never requires re-indexing;
 *  - attribution facts (tokens, estMethod, ingestRequestSeq, lastCarrySeq) are stored per tool call,
 *    per injection and per whole-context item (`context_items`), because they are price-independent
 *    and expensive to recompute.
 *
 * `requests.cache5m` / `cache1h` hold only the TTL split the transcript actually reported.
 * A cache write whose TTL the transcript did not record goes to `cacheAssumed`, which read-time
 * pricing folds into one bucket or the other per `PricingConfig.assumeCacheWriteTtlWhenUnknown` —
 * so flipping that setting re-prices without a reindex, like every other pricing edit.
 *
 * The database is a rebuildable cache, so a schema-version mismatch drops and recreates it rather
 * than running data migrations.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 4;

export const MEMORY_DB = ':memory:';

const TABLES = [
  'messages_fts',
  'sessions_fts',
  'messages',
  'api_errors',
  'compactions',
  'hook_runs',
  'context_items',
  'injections',
  'tool_calls',
  'requests',
  'workflow_runs',
  'agents',
  'files',
  'sessions',
  'projects',
  'meta',
] as const;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  dirName     TEXT NOT NULL,
  path        TEXT NOT NULL,
  displayName TEXT NOT NULL,
  parentPath  TEXT,
  isWorktree  INTEGER NOT NULL DEFAULT 0,
  isScratch   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  projectId            TEXT NOT NULL,
  provider             TEXT NOT NULL DEFAULT 'claude',
  usageIncomplete      INTEGER NOT NULL DEFAULT 0,
  cwd                  TEXT,
  title                TEXT NOT NULL,
  titleSource          TEXT NOT NULL,
  firstPrompt          TEXT NOT NULL DEFAULT '',
  startedAt            TEXT NOT NULL,
  endedAt              TEXT NOT NULL,
  startedDate          TEXT NOT NULL,
  durationMs           INTEGER NOT NULL DEFAULT 0,
  activeMs             INTEGER NOT NULL DEFAULT 0,
  entrypoint           TEXT,
  sessionKind          TEXT,
  gitBranch            TEXT,
  version              TEXT,
  effort               TEXT,
  promptCount          INTEGER NOT NULL DEFAULT 0,
  requestCount         INTEGER NOT NULL DEFAULT 0,
  toolCallCount        INTEGER NOT NULL DEFAULT 0,
  agentCount           INTEGER NOT NULL DEFAULT 0,
  workflowRunCount     INTEGER NOT NULL DEFAULT 0,
  compactionCount      INTEGER NOT NULL DEFAULT 0,
  apiErrorCount        INTEGER NOT NULL DEFAULT 0,
  hookRunCount         INTEGER NOT NULL DEFAULT 0,
  reportedCostUsd      REAL,
  reportedJson         TEXT,
  continuedInSessionId TEXT,
  permissionMode       TEXT,
  prLinksJson          TEXT NOT NULL DEFAULT '[]',
  localCommandsJson    TEXT NOT NULL DEFAULT '[]',
  turnDurationsJson    TEXT NOT NULL DEFAULT '[]',
  modelsJson           TEXT NOT NULL DEFAULT '[]',
  filePath             TEXT NOT NULL,
  lineCount            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(startedDate);
CREATE INDEX IF NOT EXISTS idx_sessions_continued ON sessions(continuedInSessionId);

CREATE TABLE IF NOT EXISTS files (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  size           INTEGER NOT NULL,
  mtimeMs        REAL NOT NULL,
  kind           TEXT NOT NULL,
  sessionId      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId        TEXT NOT NULL DEFAULT '',
  runId          TEXT,
  projectDirName TEXT NOT NULL,
  indexedAt      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_session ON files(sessionId);

CREATE TABLE IF NOT EXISTS agents (
  sessionId       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId         TEXT NOT NULL,
  runId           TEXT,
  parentAgentId   TEXT,
  parentToolUseId TEXT,
  agentType       TEXT,
  description     TEXT,
  requestedModel  TEXT,
  spawnDepth      INTEGER NOT NULL DEFAULT 0,
  startedAt       TEXT,
  endedAt         TEXT,
  requestCount    INTEGER NOT NULL DEFAULT 0,
  toolCallCount   INTEGER NOT NULL DEFAULT 0,
  filePath        TEXT NOT NULL,
  PRIMARY KEY (sessionId, agentId)
);
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(sessionId, parentAgentId);
CREATE INDEX IF NOT EXISTS idx_agents_run ON agents(sessionId, runId);

CREATE TABLE IF NOT EXISTS workflow_runs (
  sessionId      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  runId          TEXT NOT NULL,
  toolUseId      TEXT,
  agentCount     INTEGER NOT NULL DEFAULT 0,
  journalStarted INTEGER NOT NULL DEFAULT 0,
  journalResult  INTEGER NOT NULL DEFAULT 0,
  journalFailed  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sessionId, runId)
);

CREATE TABLE IF NOT EXISTS requests (
  sessionId          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId            TEXT NOT NULL DEFAULT '',
  seq                INTEGER NOT NULL,
  iterIndex          INTEGER NOT NULL DEFAULT 0,
  turnIndex          INTEGER NOT NULL,
  ts                 TEXT NOT NULL,
  dateLocal          TEXT NOT NULL,
  model              TEXT NOT NULL,
  speed              TEXT NOT NULL,
  serviceTier        TEXT NOT NULL,
  inferenceGeo       TEXT NOT NULL,
  input              INTEGER NOT NULL DEFAULT 0,
  output             INTEGER NOT NULL DEFAULT 0,
  cacheRead          INTEGER NOT NULL DEFAULT 0,
  cache5m            INTEGER NOT NULL DEFAULT 0,
  cache1h            INTEGER NOT NULL DEFAULT 0,
  cacheAssumed       INTEGER NOT NULL DEFAULT 0,
  thinking           INTEGER NOT NULL DEFAULT 0,
  webSearchRequests  INTEGER NOT NULL DEFAULT 0,
  webFetchRequests   INTEGER NOT NULL DEFAULT 0,
  contextTokens      INTEGER NOT NULL DEFAULT 0,
  stopReason         TEXT,
  isFallback         INTEGER NOT NULL DEFAULT 0,
  effort             TEXT,
  skill              TEXT,
  plugin             TEXT,
  mcpServer          TEXT,
  mcpTool            TEXT,
  messageId          TEXT,
  iterationsJson     TEXT,
  toolNamesJson      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (sessionId, agentId, seq, iterIndex)
);
CREATE INDEX IF NOT EXISTS idx_requests_date ON requests(dateLocal);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(sessionId, agentId, seq);

CREATE TABLE IF NOT EXISTS tool_calls (
  sessionId        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId          TEXT NOT NULL DEFAULT '',
  toolUseId        TEXT NOT NULL,
  name             TEXT NOT NULL,
  mcpServer        TEXT,
  mcpTool          TEXT,
  requestSeq       INTEGER NOT NULL,
  turnIndex        INTEGER NOT NULL,
  ts               TEXT NOT NULL,
  dateLocal        TEXT NOT NULL,
  inputChars       INTEGER NOT NULL DEFAULT 0,
  inputSummary     TEXT NOT NULL DEFAULT '',
  resultSeq        INTEGER,
  resultChars      INTEGER NOT NULL DEFAULT 0,
  resultImages     INTEGER NOT NULL DEFAULT 0,
  resultShape      TEXT NOT NULL DEFAULT 'missing',
  isError          INTEGER NOT NULL DEFAULT 0,
  resultPreview    TEXT NOT NULL DEFAULT '',
  childAgentId     TEXT,
  childRunId       TEXT,
  childModel       TEXT,
  childDescription TEXT,
  durationMs       INTEGER,
  genTokens        REAL NOT NULL DEFAULT 0,
  tokens           REAL NOT NULL DEFAULT 0,
  estMethod        TEXT NOT NULL DEFAULT 'none',
  ingestRequestSeq INTEGER,
  lastCarrySeq     INTEGER,
  PRIMARY KEY (sessionId, agentId, toolUseId)
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_date ON tool_calls(dateLocal);
CREATE INDEX IF NOT EXISTS idx_tool_calls_child ON tool_calls(sessionId, childAgentId);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(sessionId, agentId);

CREATE TABLE IF NOT EXISTS injections (
  id               INTEGER PRIMARY KEY,
  sessionId        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId          TEXT NOT NULL DEFAULT '',
  seq              INTEGER NOT NULL,
  turnIndex        INTEGER NOT NULL,
  ts               TEXT,
  dateLocal        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  name             TEXT NOT NULL,
  chars            INTEGER NOT NULL DEFAULT 0,
  charsSource      TEXT NOT NULL DEFAULT 'none',
  hookName         TEXT,
  hookEvent        TEXT,
  tokens           REAL NOT NULL DEFAULT 0,
  estMethod        TEXT NOT NULL DEFAULT 'none',
  ingestRequestSeq INTEGER,
  lastCarrySeq     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_injections_kind ON injections(kind);
CREATE INDEX IF NOT EXISTS idx_injections_name ON injections(name);
CREATE INDEX IF NOT EXISTS idx_injections_date ON injections(dateLocal);
CREATE INDEX IF NOT EXISTS idx_injections_session ON injections(sessionId, agentId);

CREATE TABLE IF NOT EXISTS context_items (
  id               INTEGER PRIMARY KEY,
  sessionId        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId          TEXT NOT NULL DEFAULT '',
  seq              INTEGER NOT NULL,
  turnIndex        INTEGER NOT NULL,
  dateLocal        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  tokens           REAL NOT NULL DEFAULT 0,
  estMethod        TEXT NOT NULL DEFAULT 'heuristic',
  ingestRequestSeq INTEGER,
  lastCarrySeq     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_context_items_session ON context_items(sessionId, agentId);
CREATE INDEX IF NOT EXISTS idx_context_items_date ON context_items(dateLocal);

CREATE TABLE IF NOT EXISTS hook_runs (
  id            INTEGER PRIMARY KEY,
  sessionId     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId       TEXT NOT NULL DEFAULT '',
  seq           INTEGER NOT NULL,
  turnIndex     INTEGER NOT NULL,
  ts            TEXT,
  dateLocal     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  hookName      TEXT,
  hookEvent     TEXT,
  command       TEXT,
  durationMs    INTEGER,
  exitCode      INTEGER,
  timedOut      INTEGER NOT NULL DEFAULT 0,
  hookCount     INTEGER,
  errorCount    INTEGER,
  injectedChars INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hook_runs_name ON hook_runs(hookName);
CREATE INDEX IF NOT EXISTS idx_hook_runs_date ON hook_runs(dateLocal);
CREATE INDEX IF NOT EXISTS idx_hook_runs_session ON hook_runs(sessionId, agentId);

CREATE TABLE IF NOT EXISTS compactions (
  sessionId  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId    TEXT NOT NULL DEFAULT '',
  seq        INTEGER NOT NULL,
  turnIndex  INTEGER NOT NULL,
  ts         TEXT,
  dateLocal  TEXT NOT NULL,
  trigger    TEXT,
  preTokens  INTEGER,
  postTokens INTEGER,
  durationMs INTEGER,
  PRIMARY KEY (sessionId, agentId, seq)
);
CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(sessionId, agentId);
CREATE INDEX IF NOT EXISTS idx_compactions_date ON compactions(dateLocal);

CREATE TABLE IF NOT EXISTS api_errors (
  sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId   TEXT NOT NULL DEFAULT '',
  seq       INTEGER NOT NULL,
  ts        TEXT,
  status    INTEGER,
  message   TEXT,
  PRIMARY KEY (sessionId, agentId, seq)
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  sessionId    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agentId      TEXT NOT NULL DEFAULT '',
  seq          INTEGER NOT NULL,
  turnIndex    INTEGER NOT NULL,
  uuid         TEXT NOT NULL,
  parentUuid   TEXT,
  ts           TEXT,
  dateLocal    TEXT NOT NULL,
  role         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subtype      TEXT,
  messageId    TEXT,
  requestSeq   INTEGER,
  model        TEXT,
  toolNames    TEXT,
  fileId       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  byteOffset   INTEGER NOT NULL,
  byteLength   INTEGER NOT NULL,
  preview      TEXT NOT NULL DEFAULT '',
  isMeta       INTEGER NOT NULL DEFAULT 0,
  isSidechain  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId, agentId, seq);
CREATE INDEX IF NOT EXISTS idx_messages_request ON messages(sessionId, agentId, requestSeq);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(dateLocal);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  title, firstPrompt, projectPath, sessionId UNINDEXED, tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, messageRowid UNINDEXED, tokenize='unicode61 remove_diacritics 2'
);
`;

/**
 * Thrown when the running Node build's bundled SQLite is missing a feature the index needs.
 * Homebrew's Node 23 ships a SQLite compiled without FTS5, which makes every search table fail
 * to create — a dedicated class lets the CLI print one plain sentence instead of a stack trace.
 */
export class SqliteFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteFeatureError';
  }
}

export const FTS5_REQUIRED_MESSAGE =
  "This Node build's SQLite has no FTS5. Use Node 22 LTS (nvm use — .nvmrc is set to 22).";

/**
 * Creates a throwaway fts5 table inside a transaction and rolls it back, so the check costs
 * nothing and leaves no trace. `PRAGMA compile_options` is not enough on its own: some builds
 * list ENABLE_FTS5 but fail on the trigram tokenizer this schema uses, which is exactly what
 * the probe exercises.
 */
function assertFts5(db: DatabaseSync): void {
  try {
    db.exec('BEGIN');
    db.exec("CREATE VIRTUAL TABLE temp_fts5_probe USING fts5(t, tokenize='trigram')");
    db.exec('ROLLBACK');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no transaction was open (the BEGIN itself failed); nothing to undo.
    }
    throw new SqliteFeatureError(`${FTS5_REQUIRED_MESSAGE} (${(error as Error).message})`);
  }
}

/** Drops every table this module owns. Used by `--full` reindex and by the version check. */
export function resetDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec('PRAGMA foreign_keys = ON');
  createSchema(db);
}

export function createSchema(db: DatabaseSync): void {
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  const value = row ? row['user_version'] : 0;
  return typeof value === 'number' ? value : 0;
}

/**
 * Opens (and creates) the index database with the pragmas the app relies on.
 * `:memory:` is supported for tests; on disk the directory is created 0700 and the file 0600.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== MEMORY_DB) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  if (path !== MEMORY_DB) {
    db.exec('PRAGMA journal_mode = WAL');
    try {
      chmodSync(path, 0o600);
    } catch {
      // A pre-existing file owned by another user is a configuration problem, not a fatal one.
    }
  }
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  try {
    assertFts5(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const version = readUserVersion(db);
  if (version === 0) createSchema(db);
  else if (version !== SCHEMA_VERSION) resetDatabase(db);
  return db;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  const value = row?.['value'];
  return typeof value === 'string' ? value : null;
}

export const META_LAST_INDEXED_AT = 'lastIndexedAt';

/**
 * Incremental indexer (SPEC §6).
 *
 * discover → compare `(path, size, mtimeMs)` against the `files` table → parse only the sessions
 * whose files changed → attribute → write every row for that session inside one transaction.
 * Idempotent and resumable: an interrupted run leaves finished sessions indexed and re-does only
 * the session it was in the middle of.
 */
import type { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import type { DiscoveredSession, DiscoverWarning, IndexFailure, IndexProgress, ParsedSession, PricingConfig } from '../types.js';
import type { IndexResult, IndexerOptions } from '../store.js';
import { defaultPricing } from '../pricing/defaults.js';
import { META_LAST_INDEXED_AT, getMeta, openDatabase, resetDatabase, setMeta } from './schema.js';
import { refreshProjects } from './projects.js';
import { SessionWriter, fileSignature } from './write-session.js';
import { str, num, type Row } from './rows.js';
import { splitOpenCodePath } from '../opencode/db.js';

/** Bump when derived parser facts change even if transcript bytes and DB columns do not. */
export const PARSER_VERSION = '4';
export const META_PARSER_VERSION = 'parser_version';

export interface IndexerRunOptions extends IndexerOptions {
  /** pricing is needed at index time only for `charsPerToken` in attribution */
  pricing?: PricingConfig;
}

class Progress {
  private readonly state: IndexProgress;

  constructor(private readonly emit: ((p: IndexProgress) => void) | undefined) {
    this.state = {
      phase: 'discover',
      filesDone: 0,
      filesTotal: 0,
      sessionsDone: 0,
      sessionsTotal: 0,
      startedAt: new Date().toISOString(),
    };
  }

  update(patch: Partial<IndexProgress>): void {
    Object.assign(this.state, patch);
    this.emit?.({ ...this.state });
  }

  get snapshot(): IndexProgress {
    return { ...this.state };
  }
}

function filesOf(session: DiscoveredSession): { path: string; size: number; mtimeMs: number }[] {
  const files = [session.mainFile, ...session.agentFiles];
  for (const run of session.workflowRuns) files.push(...run.agentFiles);
  return files.map((f) => ({ path: f.path, size: f.size, mtimeMs: f.mtimeMs }));
}

function storedSignature(db: DatabaseSync, sessionId: string): string | null {
  const rows = db
    .prepare('SELECT path, size, mtimeMs FROM files WHERE sessionId = ?')
    .all(sessionId) as Row[];
  if (rows.length === 0) return null;
  return fileSignature(rows.map((r) => ({ path: str(r, 'path'), size: num(r, 'size'), mtimeMs: num(r, 'mtimeMs') })));
}

function sessionExists(db: DatabaseSync, sessionId: string): boolean {
  return db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined;
}

interface DiscoverOutcome {
  sessions: DiscoveredSession[];
  warnings: DiscoverWarning[];
}

async function loadDiscover(opts: IndexerOptions): Promise<(roots: string[]) => Promise<DiscoverOutcome>> {
  if (opts.discover) {
    const discover = opts.discover;
    return async (roots) => ({ sessions: await discover(roots), warnings: [] });
  }
  const run = opts.discoverWithWarnings ?? (await import('../discover.js')).discoverSessionsWithWarnings;
  return async (roots) => {
    const { sessions, warnings } = await run(roots);
    return {
      sessions,
      warnings: warnings.slice(0, MAX_DISCOVER_WARNINGS).map((w) => ({
        path: homeRelative(w.path),
        message: homeRelative(w.message).slice(0, MAX_FAILURE_ERROR),
      })),
    };
  };
}

async function loadParse(opts: IndexerOptions): Promise<(s: DiscoveredSession) => Promise<ParsedSession>> {
  if (opts.parse) return opts.parse;
  const mod = await import('../parse/index.js');
  return mod.parseSession;
}

interface KnownFailure {
  signature: string;
  failure: IndexFailure;
}

const META_INDEX_FAILURES = 'index_failures';
const MAX_FAILURE_ERROR = 300;
const MAX_DISCOVER_WARNINGS = 50;

function loadKnownFailures(db: DatabaseSync): Record<string, KnownFailure> {
  const raw = getMeta(db, META_INDEX_FAILURES);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, KnownFailure>) : {};
  } catch {
    return {};
  }
}

function saveKnownFailures(db: DatabaseSync, known: Record<string, KnownFailure>): void {
  if (Object.keys(known).length === 0) db.prepare('DELETE FROM meta WHERE key = ?').run(META_INDEX_FAILURES);
  else setMeta(db, META_INDEX_FAILURES, JSON.stringify(known));
}

/** Replaces the home directory with `~` so failures never expose the user's name or layout. */
function homeRelative(text: string): string {
  const home = homedir();
  return home && home !== '/' ? text.split(home).join('~') : text;
}

function describeFailure(discovered: DiscoveredSession, phase: IndexFailure['phase'], error: unknown): IndexFailure {
  const e = error as Error | undefined;
  const text = `${e?.name || 'Error'}: ${e?.message ?? ''}`;
  return {
    sessionId: discovered.sessionId,
    provider: discovered.provider ?? 'claude',
    paths: filesOf(discovered).map((f) => homeRelative(f.path)),
    phase,
    error: homeRelative(text).slice(0, MAX_FAILURE_ERROR),
  };
}

interface IndexPassArgs {
  db: DatabaseSync;
  sessions: DiscoveredSession[];
  parse: (s: DiscoveredSession) => Promise<ParsedSession>;
  pricing: PricingConfig;
  progress: Progress;
  signal?: AbortSignal;
  /** when true, sessions are re-parsed even if their files are unchanged (and known failures retried) */
  force: boolean;
}

async function indexPass(args: IndexPassArgs): Promise<IndexResult> {
  const { db, sessions, parse, pricing, progress, signal, force } = args;
  const started = Date.now();
  const writer = new SessionWriter(db);
  const knownFailures = loadKnownFailures(db);
  const result: IndexResult = {
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    filesSeen: 0,
    parseErrors: 0,
    sessionsFailed: 0,
    sessionsSkippedFailed: 0,
    failures: [],
    durationMs: 0,
    changedSessionIds: [],
  };

  const filesTotal = sessions.reduce((sum, s) => sum + filesOf(s).length, 0);
  progress.update({ phase: 'parse', filesTotal, sessionsTotal: sessions.length, filesDone: 0, sessionsDone: 0 });

  const recordFailure = (discovered: DiscoveredSession, signature: string, failure: IndexFailure): void => {
    knownFailures[discovered.sessionId] = { signature, failure };
    result.parseErrors += 1;
    result.sessionsFailed = (result.sessionsFailed ?? 0) + 1;
    result.failures?.push(failure);
  };

  let filesDone = 0;
  let sessionsDone = 0;
  for (const discovered of sessions) {
    if (signal?.aborted) break;
    const files = filesOf(discovered);
    result.filesSeen += files.length;
    filesDone += files.length;
    sessionsDone += 1;
    const signature = fileSignature(files);

    const unchanged =
      !force &&
      sessionExists(db, discovered.sessionId) &&
      storedSignature(db, discovered.sessionId) === signature;
    if (unchanged) {
      result.sessionsSkipped += 1;
      delete knownFailures[discovered.sessionId];
      progress.update({ filesDone, sessionsDone, currentProject: discovered.projectDirName });
      continue;
    }

    const known = knownFailures[discovered.sessionId];
    if (!force && known && known.signature === signature) {
      result.sessionsSkippedFailed = (result.sessionsSkippedFailed ?? 0) + 1;
      result.failures?.push(known.failure);
      progress.update({ filesDone, sessionsDone, currentProject: discovered.projectDirName });
      continue;
    }

    progress.update({ phase: 'parse', filesDone, sessionsDone, currentProject: discovered.projectDirName });
    let parsed: ParsedSession;
    try {
      parsed = await parse(discovered);
    } catch (error) {
      recordFailure(discovered, signature, describeFailure(discovered, 'parse', error));
      progress.update({
        phase: 'parse',
        message: `parse failed for one session (${(error as Error).name || 'Error'})`,
      });
      continue;
    }

    progress.update({ phase: 'write', filesDone, sessionsDone, currentProject: discovered.projectDirName });
    db.exec('BEGIN IMMEDIATE');
    try {
      writer.write(parsed, pricing);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      // One session that cannot be written must not stop the sessions after it from indexing.
      recordFailure(discovered, signature, describeFailure(discovered, 'write', error));
      progress.update({ phase: 'write', message: `write failed for one session (${(error as Error).name || 'Error'})` });
      continue;
    }
    delete knownFailures[discovered.sessionId];
    result.parseErrors += parsed.main.meta.parseErrors;
    result.sessionsIndexed += 1;
    result.changedSessionIds.push(discovered.sessionId);
  }

  saveKnownFailures(db, knownFailures);
  refreshProjects(db);
  setMeta(db, META_LAST_INDEXED_AT, new Date().toISOString());
  result.durationMs = Date.now() - started;
  progress.update({ phase: 'done', filesDone, sessionsDone });
  return result;
}

/** Full or incremental index of every root. Sessions that vanished from disk are removed. */
export async function runIndex(opts: IndexerRunOptions): Promise<IndexResult> {
  const db = openDatabase(opts.dbPath);
  try {
    if (opts.full) resetDatabase(db);
    const progress = new Progress(opts.onProgress);
    progress.update({ phase: 'discover' });
    const discover = await loadDiscover(opts);
    const { sessions, warnings } = await discover(opts.roots);
    progress.update({ sessionsTotal: sessions.length });

    const known = new Set(sessions.map((s) => s.sessionId));
    const knownFailures = loadKnownFailures(db);
    const staleFailures = Object.keys(knownFailures).filter((id) => !known.has(id));
    if (staleFailures.length > 0) {
      for (const id of staleFailures) delete knownFailures[id];
      saveKnownFailures(db, knownFailures);
    }
    const writer = new SessionWriter(db);
    const stale = (db.prepare('SELECT id FROM sessions').all() as Row[])
      .map((row) => str(row, 'id'))
      .filter((id) => !known.has(id));
    if (stale.length > 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of stale) writer.deleteSession(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    const parse = await loadParse(opts);
    const result = await indexPass({
      db,
      sessions,
      parse,
      pricing: opts.pricing ?? defaultPricing(),
      progress,
      ...(opts.signal ? { signal: opts.signal } : {}),
      force: opts.full === true || getMeta(db, META_PARSER_VERSION) !== PARSER_VERSION,
    });
    if (!opts.signal?.aborted) setMeta(db, META_PARSER_VERSION, PARSER_VERSION);
    result.changedSessionIds.push(...stale);
    result.discoverWarnings = warnings;
    return result;
  } finally {
    db.close();
  }
}

/**
 * Watcher path: re-index only the sessions that own the given changed paths.
 * Discovery still runs (it is cheap relative to parsing) so newly created files are picked up.
 */
export async function indexChangedFiles(paths: string[], opts: IndexerRunOptions): Promise<IndexResult> {
  const db = openDatabase(opts.dbPath);
  try {
    // A watcher must not leave untouched sessions with stale titles/search facts after an upgrade.
    if (getMeta(db, META_PARSER_VERSION) !== PARSER_VERSION) return await runIndex(opts);
    const progress = new Progress(opts.onProgress);
    progress.update({ phase: 'discover' });
    const discover = await loadDiscover(opts);
    const { sessions: all, warnings } = await discover(opts.roots);
    // OpenCode sessions live inside one SQLite file; its write-ahead log signals the same change.
    const wanted = new Set(paths.map((p) => p.replace(/\.db-(?:wal|shm)$/, '.db')));
    const sessions = all.filter((session) =>
      filesOf(session).some((file) =>
        wanted.has(file.path) || wanted.has(splitOpenCodePath(file.path)?.dbPath ?? file.path)
        || [...wanted].some((p) => p.startsWith(`${file.path}/`))),
    );
    if (sessions.length === 0) {
      progress.update({ phase: 'done' });
      return {
        sessionsIndexed: 0,
        sessionsSkipped: 0,
        filesSeen: 0,
        parseErrors: 0,
        durationMs: 0,
        changedSessionIds: [],
        discoverWarnings: warnings,
      };
    }
    const parse = await loadParse(opts);
    const result = await indexPass({
      db,
      sessions,
      parse,
      pricing: opts.pricing ?? defaultPricing(),
      progress,
      ...(opts.signal ? { signal: opts.signal } : {}),
      force: false,
    });
    result.discoverWarnings = warnings;
    return result;
  } finally {
    db.close();
  }
}

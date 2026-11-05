/**
 * Walks `~/.claude/projects`-shaped roots and groups the JSONL files on disk into sessions
 * (SPEC §3.1). Nothing here parses transcript content; the only file ever opened is a legacy
 * project-level `agent-*.jsonl`, whose owning session id is not in its path.
 *
 * Discovery never throws on a bad tree: every unreadable entry becomes a warning.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { CodexScan, isCodexRoot } from './codex/discover.js';
import { readJsonlLines } from './jsonl.js';
import type {
  DiscoveredFile,
  DiscoveredSession,
  DiscoveredWorkflowRun,
  SessionsIndexEntry,
  TranscriptKind,
} from './types.js';
import { asRecord, asString, parseJson } from './parse/raw.js';

export interface DiscoveryWarning {
  path: string;
  message: string;
}

export interface DiscoveryResult {
  sessions: DiscoveredSession[];
  warnings: DiscoveryWarning[];
}

/** Directory names inside a session directory that hold no transcripts. */
const SKIPPED_SESSION_SUBDIRS = new Set(['tool-results', 'workflows']);
/** Directory names inside a project directory that hold no transcripts. */
const SKIPPED_PROJECT_SUBDIRS = new Set(['memory']);

const AGENT_FILE = /^agent-(.+)\.jsonl$/;
const WORKFLOW_DIR = /^wf_/;

/** Expands a leading `~` to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~' + path.sep)) return path.join(homedir(), p.slice(2));
  return p;
}

export async function discoverSessions(roots: string[]): Promise<DiscoveredSession[]> {
  const { sessions } = await discoverSessionsWithWarnings(roots);
  return sessions;
}

export async function discoverSessionsWithWarnings(roots: string[]): Promise<DiscoveryResult> {
  const ctx = new Scan();
  const codex = new CodexScan();
  const seenRoots = new Set<string>();
  for (const root of roots) {
    const resolved = path.resolve(expandHome(root));
    let canonical = resolved;
    try { canonical = await realpath(resolved); } catch { /* scan reports unreadable roots */ }
    if (seenRoots.has(canonical)) continue;
    seenRoots.add(canonical);
    if (await isCodexRoot(resolved)) await codex.scan(resolved);
    else await ctx.scanRoot(resolved);
  }
  ctx.sessions.push(...codex.finish());
  ctx.warnings.push(...codex.warnings);
  // Code-point ordering, not `localeCompare`: discovery order must not depend on the host locale.
  ctx.sessions.sort((a, b) =>
    a.projectDirName === b.projectDirName
      ? compare(a.sessionId, b.sessionId)
      : compare(a.projectDirName, b.projectDirName),
  );
  return { sessions: ctx.sessions, warnings: ctx.warnings };
}

interface SessionDirContents {
  customTitlePath?: string;
  agentFiles: DiscoveredFile[];
  workflowRuns: DiscoveredWorkflowRun[];
}

class Scan {
  readonly sessions: DiscoveredSession[] = [];
  readonly warnings: DiscoveryWarning[] = [];
  private readonly projects = new Set<string>();

  warn(p: string, err: unknown): void {
    this.warnings.push({ path: p, message: err instanceof Error ? err.message : String(err) });
  }

  async list(dir: string): Promise<{ dirs: string[]; files: string[] } | null> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const dirs: string[] = [];
      const files: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) dirs.push(e.name);
        else if (e.isFile()) files.push(e.name);
        else if (e.isSymbolicLink()) {
          try {
            const s = await stat(path.join(dir, e.name));
            (s.isDirectory() ? dirs : files).push(e.name);
          } catch (err) {
            this.warn(path.join(dir, e.name), err);
          }
        }
      }
      dirs.sort();
      files.sort();
      return { dirs, files };
    } catch (err) {
      this.warn(dir, err);
      return null;
    }
  }

  async file(
    filePath: string,
    base: Omit<DiscoveredFile, 'path' | 'size' | 'mtimeMs'>,
  ): Promise<DiscoveredFile | null> {
    try {
      const s = await stat(filePath);
      return { ...base, path: filePath, size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      this.warn(filePath, err);
      return null;
    }
  }

  async scanRoot(root: string): Promise<void> {
    const listing = await this.list(root);
    if (!listing) return;
    for (const name of listing.dirs) {
      await this.scanProject(path.join(root, name), name);
    }
  }

  async scanProject(projectDirPath: string, projectDirName: string): Promise<void> {
    try {
      const canonical = await realpath(projectDirPath);
      if (this.projects.has(canonical)) return;
      this.projects.add(canonical);
    } catch { /* listing below reports the failure */ }
    const listing = await this.list(projectDirPath);
    if (!listing) return;

    const indexEntries = await this.readSessionsIndex(projectDirPath, listing.files);

    const mainFiles = new Map<string, DiscoveredFile>();
    const legacyAgentPaths: { path: string; agentId: string }[] = [];
    for (const name of listing.files) {
      if (!name.endsWith('.jsonl')) continue;
      const legacy = AGENT_FILE.exec(name);
      if (legacy?.[1]) {
        legacyAgentPaths.push({ path: path.join(projectDirPath, name), agentId: legacy[1] });
        continue;
      }
      const sessionId = name.slice(0, -'.jsonl'.length);
      const f = await this.file(path.join(projectDirPath, name), {
        kind: 'main',
        projectDirName,
        sessionId,
      });
      if (f) mainFiles.set(sessionId, f);
    }

    const sessionDirs = new Map<string, SessionDirContents>();
    for (const name of listing.dirs) {
      if (SKIPPED_PROJECT_SUBDIRS.has(name)) continue;
      const contents = await this.scanSessionDir(path.join(projectDirPath, name), projectDirName, name);
      if (contents) sessionDirs.set(name, contents);
    }

    const built = new Map<string, DiscoveredSession>();
    for (const [sessionId, mainFile] of mainFiles) {
      const dir = sessionDirs.get(sessionId);
      const session: DiscoveredSession = {
        projectDirName,
        projectDirPath,
        sessionId,
        mainFile,
        agentFiles: dir?.agentFiles ?? [],
        workflowRuns: dir?.workflowRuns ?? [],
      };
      if (dir?.customTitlePath) session.customTitlePath = dir.customTitlePath;
      const entry = indexEntries.get(sessionId);
      if (entry) session.indexEntry = entry;
      built.set(sessionId, session);
      this.sessions.push(session);
    }

    for (const [name] of sessionDirs) {
      if (!mainFiles.has(name)) {
        this.warnings.push({
          path: path.join(projectDirPath, name),
          message: 'session directory has no matching <sessionId>.jsonl; agents ignored',
        });
      }
    }

    for (const legacy of legacyAgentPaths) {
      await this.attachLegacyAgent(legacy.path, legacy.agentId, projectDirName, built);
    }
  }

  /** Legacy layout: `agent-<id>.jsonl` sitting directly in the project dir. */
  async attachLegacyAgent(
    filePath: string,
    agentId: string,
    projectDirName: string,
    sessions: Map<string, DiscoveredSession>,
  ): Promise<void> {
    const sessionId = await this.sessionIdOf(filePath);
    if (!sessionId) {
      this.warnings.push({ path: filePath, message: 'legacy agent file has no derivable sessionId' });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      this.warnings.push({
        path: filePath,
        message: `legacy agent file references unknown session ${sessionId}`,
      });
      return;
    }
    const meta = filePath.replace(/\.jsonl$/, '.meta.json');
    const base: Omit<DiscoveredFile, 'path' | 'size' | 'mtimeMs'> = {
      kind: 'subagent',
      projectDirName,
      sessionId,
      agentId,
    };
    if (await exists(meta)) base.metaPath = meta;
    const f = await this.file(filePath, base);
    if (f) session.agentFiles.push(f);
  }

  /** Reads the first lines of a transcript looking for the envelope `sessionId`. */
  async sessionIdOf(filePath: string): Promise<string | undefined> {
    try {
      let seen = 0;
      for await (const line of readJsonlLines(filePath)) {
        if (++seen > 20) break;
        const obj = asRecord(parseJson(line.text));
        const sessionId = asString(obj?.['sessionId']);
        if (sessionId) return sessionId;
      }
    } catch (err) {
      this.warn(filePath, err);
    }
    return undefined;
  }

  async scanSessionDir(
    dirPath: string,
    projectDirName: string,
    sessionId: string,
  ): Promise<SessionDirContents | null> {
    const listing = await this.list(dirPath);
    if (!listing) return null;
    const contents: SessionDirContents = { agentFiles: [], workflowRuns: [] };
    if (listing.files.includes('custom-title.json')) {
      contents.customTitlePath = path.join(dirPath, 'custom-title.json');
    }
    if (!listing.dirs.includes('subagents')) return contents;

    const subagentsDir = path.join(dirPath, 'subagents');
    if (!(await this.containedIn(subagentsDir, dirPath))) return contents;
    const sub = await this.list(subagentsDir);
    if (!sub) return contents;

    contents.agentFiles = await this.agentFilesIn(sub.files, subagentsDir, {
      kind: 'subagent',
      projectDirName,
      sessionId,
    });

    if (sub.dirs.includes('workflows')) {
      const workflowsDir = path.join(subagentsDir, 'workflows');
      const wf = await this.list(workflowsDir);
      for (const runDirName of wf?.dirs ?? []) {
        if (!WORKFLOW_DIR.test(runDirName)) continue;
        const runDir = path.join(workflowsDir, runDirName);
        // A resumed run is symlinked into the new session; the canonical session owns its agents,
        // so following the link here would bill the same transcripts twice.
        if (!(await this.containedIn(runDir, dirPath))) continue;
        const runListing = await this.list(runDir);
        if (!runListing) continue;
        const run: DiscoveredWorkflowRun = {
          runId: runDirName,
          dir: runDir,
          agentFiles: await this.agentFilesIn(runListing.files, runDir, {
            kind: 'workflow-agent',
            projectDirName,
            sessionId,
            runId: runDirName,
          }),
        };
        if (runListing.files.includes('journal.jsonl')) {
          run.journalPath = path.join(runDir, 'journal.jsonl');
        }
        contents.workflowRuns.push(run);
      }
      contents.workflowRuns.sort((a, b) => compare(a.runId, b.runId));
    }
    return contents;
  }

  async agentFilesIn(
    names: string[],
    dir: string,
    base: { kind: TranscriptKind; projectDirName: string; sessionId: string; runId?: string },
  ): Promise<DiscoveredFile[]> {
    const out: DiscoveredFile[] = [];
    const present = new Set(names);
    for (const name of names) {
      const m = AGENT_FILE.exec(name);
      if (!m?.[1]) continue;
      const agentId = m[1];
      const metaName = `agent-${agentId}.meta.json`;
      const fileBase: Omit<DiscoveredFile, 'path' | 'size' | 'mtimeMs'> = { ...base, agentId };
      if (present.has(metaName)) fileBase.metaPath = path.join(dir, metaName);
      const f = await this.file(path.join(dir, name), fileBase);
      if (f) out.push(f);
    }
    return out;
  }

  /**
   * True when `target` resolves to a path inside `container`. Symlinked run directories that point
   * at another session are reported as a warning and skipped.
   */
  async containedIn(target: string, container: string): Promise<boolean> {
    try {
      const [resolvedTarget, resolvedContainer] = await Promise.all([realpath(target), realpath(container)]);
      if (resolvedTarget === resolvedContainer || resolvedTarget.startsWith(resolvedContainer + path.sep)) {
        return true;
      }
      this.warnings.push({ path: target, message: 'symlink points outside its session; owned by another session' });
      return false;
    } catch (err) {
      this.warn(target, err);
      return false;
    }
  }

  async readSessionsIndex(
    projectDirPath: string,
    files: string[],
  ): Promise<Map<string, SessionsIndexEntry>> {
    const out = new Map<string, SessionsIndexEntry>();
    if (!files.includes('sessions-index.json')) return out;
    const p = path.join(projectDirPath, 'sessions-index.json');
    try {
      const raw = asRecord(parseJson(await readFile(p, 'utf8')));
      const entries = raw?.['entries'];
      if (!Array.isArray(entries)) return out;
      for (const item of entries) {
        const e = asRecord(item);
        const sessionId = asString(e?.['sessionId']);
        if (!e || !sessionId) continue;
        const entry: SessionsIndexEntry = { sessionId };
        assignString(entry, 'fullPath', e['fullPath']);
        assignString(entry, 'firstPrompt', e['firstPrompt']);
        assignString(entry, 'summary', e['summary']);
        assignString(entry, 'created', e['created']);
        assignString(entry, 'modified', e['modified']);
        assignString(entry, 'gitBranch', e['gitBranch']);
        assignString(entry, 'projectPath', e['projectPath']);
        if (typeof e['messageCount'] === 'number') entry.messageCount = e['messageCount'];
        out.set(sessionId, entry);
      }
    } catch (err) {
      this.warn(p, err);
    }
    return out;
  }
}

function assignString(
  entry: SessionsIndexEntry,
  key: 'fullPath' | 'firstPrompt' | 'summary' | 'created' | 'modified' | 'gitBranch' | 'projectPath',
  value: unknown,
): void {
  if (typeof value === 'string') entry[key] = value;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discovers Google Gemini CLI (`~/.gemini/tmp/<project>/chats/session-*.jsonl|json`) and
 * Google Antigravity (`~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript*.jsonl`,
 * plus `antigravity-cli` and `antigravity-ide`) sessions. Auth, OAuth, account, MCP and settings
 * files are never listed or opened.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readJsonlLines } from '../jsonl.js';
import { asRecord, parseJson, str } from '../parse/raw.js';
import type { DiscoveredSession } from '../types.js';
import type { DiscoveryWarning } from '../discover.js';
import { ANTIGRAVITY_SUMMARIES_DB, readAntigravitySummaries, type AntigravitySummaryRow } from './summaries.js';

const GEMINI_SESSION_FILE = /^session-.*\.(?:jsonl|json)$/;
const ANTIGRAVITY_APP_DIRS = ['antigravity', 'antigravity-cli', 'antigravity-ide'] as const;

export class GeminiScan {
  readonly sessions: DiscoveredSession[] = [];
  readonly warnings: DiscoveryWarning[] = [];
  private readonly visitedDirs = new Set<string>();
  private readonly visitedFiles = new Set<string>();
  private readonly ids = new Map<string, DiscoveredSession>();
  private readonly parents = new Map<string, string>();
  private readonly summaryCache = new Map<string, Map<string, AntigravitySummaryRow>>();
  private readonly projectsJsonCache = new Map<string, Map<string, string>>();

  async scan(root: string): Promise<void> {
    try {
      const canonical = await realpath(root);
      if (this.visitedDirs.has(canonical)) return;
      this.visitedDirs.add(canonical);
    } catch {
      this.warnings.push({ path: root, message: 'Gemini transcript directory is unreadable' });
      return;
    }

    const base = path.basename(root);
    // If pointed at `~/.gemini` (or an equivalent wrapper), visit only the known transcript subtrees.
    if (base === '.gemini' || (await hasGeminiHomeLayout(root))) {
      for (const sub of ['tmp', ...ANTIGRAVITY_APP_DIRS.map((d) => path.join(d, 'brain'))]) {
        const candidate = path.join(root, sub);
        if (await isDir(candidate)) await this.scan(candidate);
      }
      return;
    }

    // Antigravity app directory (`~/.gemini/antigravity-cli`, `~/.gemini/antigravity`, etc.): descend only into `brain`.
    if (await isDir(path.join(root, 'brain'))) {
      await this.scanBrainRoot(path.join(root, 'brain'));
      return;
    }

    // Direct Antigravity `brain` directory or single conversation directory.
    if (base === 'brain' || (await hasAntigravityConversationLayout(root))) {
      await this.scanBrainRoot(root);
      return;
    }

    // Direct Antigravity logs directory (`.../.system_generated/logs`).
    if (await hasAntigravityTranscriptFile(root)) {
      const convId = inferAntigravityConversationId(root);
      await this.scanAntigravityLogsDir(root, convId, undefined);
      return;
    }

    // Gemini CLI `tmp`, `<project>`, or `chats` directory.
    await this.scanGeminiCliRoot(root);
  }

  finish(): DiscoveredSession[] {
    const children = new Set<string>();
    for (const session of this.sessions) {
      let parentId = this.parents.get(session.sessionId);
      let owner: DiscoveredSession | undefined;
      const visited = new Set([session.sessionId]);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = this.ids.get(parentId);
        if (!parent) break;
        owner = parent;
        parentId = this.parents.get(parentId);
      }
      if (!owner || (parentId && visited.has(parentId))) continue;
      children.add(session.sessionId);
      const prefix = session.sessionId.startsWith('antigravity-') ? 'antigravity-' : 'gemini-';
      owner.agentFiles.push({
        ...session.mainFile,
        kind: 'subagent',
        sessionId: owner.sessionId,
        agentId: session.sessionId.slice(prefix.length),
      });
    }
    return this.sessions.filter((session) => !children.has(session.sessionId));
  }

  private summariesNear(brainRoot: string): Map<string, AntigravitySummaryRow> {
    const appDir = path.basename(brainRoot) === 'brain' ? path.dirname(brainRoot) : brainRoot;
    const dbPath = path.join(appDir, ANTIGRAVITY_SUMMARIES_DB);
    let cached = this.summaryCache.get(dbPath);
    if (!cached) {
      cached = readAntigravitySummaries(dbPath);
      this.summaryCache.set(dbPath, cached);
    }
    return cached;
  }

  private async scanBrainRoot(brainRoot: string): Promise<void> {
    if (await isDir(path.join(brainRoot, '.system_generated', 'logs'))) {
      const summaries = this.summariesNear(path.dirname(brainRoot));
      const convId = path.basename(brainRoot);
      await this.scanAntigravityLogsDir(path.join(brainRoot, '.system_generated', 'logs'), convId, summaries.get(convId));
      return;
    }
    let entries;
    try {
      entries = (await readdir(brainRoot, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      this.warnings.push({ path: brainRoot, message: 'Antigravity brain directory is unreadable' });
      return;
    }
    const summaries = this.summariesNear(brainRoot);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const convDir = path.join(brainRoot, entry.name);
      const logsDir = path.join(convDir, '.system_generated', 'logs');
      if (!(await isDir(logsDir))) continue;
      await this.scanAntigravityLogsDir(logsDir, entry.name, summaries.get(entry.name));
    }
  }

  private async scanAntigravityLogsDir(
    logsDir: string,
    conversationId: string,
    summary: AntigravitySummaryRow | undefined,
  ): Promise<void> {
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');
    const compactPath = path.join(logsDir, 'transcript.jsonl');
    const chosen = (await isFile(fullPath)) ? fullPath : (await isFile(compactPath)) ? compactPath : undefined;
    if (!chosen) return;
    try {
      const canonical = await realpath(chosen);
      if (this.visitedFiles.has(canonical)) return;
      this.visitedFiles.add(canonical);
      const st = await stat(chosen);
      const sessionId = `antigravity-${conversationId}`;
      if (summary?.parentId) this.parents.set(sessionId, `antigravity-${summary.parentId}`);
      const cwd = summary?.cwd;
      const projectDirName = cwd
        ? `gemini-project-${Buffer.from(cwd).toString('base64url')}`
        : `antigravity-unknown-${conversationId}`;
      const session: DiscoveredSession = {
        provider: 'gemini',
        projectDirName,
        projectDirPath: cwd ?? path.dirname(logsDir),
        sessionId,
        mainFile: {
          provider: 'gemini',
          path: chosen,
          size: st.size,
          mtimeMs: st.mtimeMs,
          kind: 'main',
          projectDirName,
          sessionId,
        },
        agentFiles: [],
        workflowRuns: [],
      };
      this.upsertSession(session);
    } catch {
      this.warnings.push({ path: chosen, message: 'Antigravity transcript is unreadable' });
    }
  }

  private async scanGeminiCliRoot(root: string): Promise<void> {
    let entries;
    try {
      entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      this.warnings.push({ path: root, message: 'Gemini CLI transcript directory is unreadable' });
      return;
    }

    // Direct `chats` directory or flat fixture directory containing `session-*.jsonl|json`.
    const sessionFiles = entries.filter(
      (e) => (e.isFile() || e.isSymbolicLink()) && GEMINI_SESSION_FILE.test(e.name),
    );
    if (sessionFiles.length > 0) {
      const projectDir = path.basename(root) === 'chats' ? path.dirname(root) : root;
      const cwd = await this.resolveGeminiCliProjectCwd(projectDir);
      for (const entry of sessionFiles) {
        await this.scanGeminiCliFile(path.join(root, entry.name), cwd);
      }
    }

    // `<project>/chats` inside a single project folder.
    if (entries.some((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name === 'chats')) {
      const cwd = await this.resolveGeminiCliProjectCwd(root);
      await this.scanGeminiCliChatsDir(path.join(root, 'chats'), cwd);
      return;
    }

    // `tmp` directory containing one subdirectory per project (`<tmp>/<project>/chats`).
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'bin') continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const projectDir = path.join(root, entry.name);
      const chatsDir = path.join(projectDir, 'chats');
      if (await isDir(chatsDir)) {
        const cwd = await this.resolveGeminiCliProjectCwd(projectDir);
        await this.scanGeminiCliChatsDir(chatsDir, cwd);
      }
    }
  }

  private async scanGeminiCliChatsDir(chatsDir: string, projectCwd: string | undefined): Promise<void> {
    let entries;
    try {
      entries = (await readdir(chatsDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      this.warnings.push({ path: chatsDir, message: 'Gemini CLI chats directory is unreadable' });
      return;
    }
    for (const entry of entries) {
      if (!(entry.isFile() || entry.isSymbolicLink()) || !GEMINI_SESSION_FILE.test(entry.name)) continue;
      await this.scanGeminiCliFile(path.join(chatsDir, entry.name), projectCwd);
    }
  }

  private async resolveGeminiCliProjectCwd(projectDir: string): Promise<string | undefined> {
    const marker = path.join(projectDir, '.project_root');
    try {
      const raw = (await readFile(marker, 'utf8')).trim();
      if (raw && path.isAbsolute(raw)) return raw;
    } catch {
      // Fall back to sibling `projects.json` when `.project_root` is absent.
    }
    const tmpDir = path.dirname(projectDir);
    const geminiHome = path.basename(tmpDir) === 'tmp' ? path.dirname(tmpDir) : tmpDir;
    const projectsJsonPath = path.join(geminiHome, 'projects.json');
    let map = this.projectsJsonCache.get(projectsJsonPath);
    if (!map) {
      map = new Map<string, string>();
      try {
        const parsed = asRecord(parseJson(await readFile(projectsJsonPath, 'utf8')));
        const projects = asRecord(parsed?.['projects']);
        if (projects) {
          for (const [cwd, slug] of Object.entries(projects)) {
            if (typeof slug === 'string' && path.isAbsolute(cwd)) map.set(slug, cwd);
          }
        }
      } catch {
        // Optional mapping file.
      }
      this.projectsJsonCache.set(projectsJsonPath, map);
    }
    return map.get(path.basename(projectDir));
  }

  private async scanGeminiCliFile(filePath: string, fallbackCwd: string | undefined): Promise<void> {
    try {
      const canonical = await realpath(filePath);
      if (this.visitedFiles.has(canonical)) return;
      this.visitedFiles.add(canonical);

      const header = await readGeminiCliHeader(filePath);
      const stem = path.basename(filePath).replace(/\.(?:jsonl|json)$/, '').replace(/^session-/, '');
      const rawId = header?.sessionId ?? stem;
      if (!rawId) {
        this.warnings.push({ path: filePath, message: 'Gemini CLI session has no derivable sessionId' });
        return;
      }
      const sessionId = `gemini-${rawId}`;
      if (header?.parentSessionId) this.parents.set(sessionId, `gemini-${header.parentSessionId}`);
      const cwd = header?.cwd ?? fallbackCwd;
      const projectKey = cwd ?? header?.projectHash ?? path.dirname(filePath);
      const projectDirName = cwd
        ? `gemini-project-${Buffer.from(cwd).toString('base64url')}`
        : `gemini-unknown-${Buffer.from(projectKey).toString('base64url').slice(0, 24)}`;
      const st = await stat(filePath);
      const session: DiscoveredSession = {
        provider: 'gemini',
        projectDirName,
        projectDirPath: cwd ?? path.dirname(filePath),
        sessionId,
        mainFile: {
          provider: 'gemini',
          path: filePath,
          size: st.size,
          mtimeMs: st.mtimeMs,
          kind: 'main',
          projectDirName,
          sessionId,
        },
        agentFiles: [],
        workflowRuns: [],
      };
      this.upsertSession(session);
    } catch {
      this.warnings.push({ path: filePath, message: 'Gemini CLI session file is unreadable' });
    }
  }

  private upsertSession(session: DiscoveredSession): void {
    const previous = this.ids.get(session.sessionId);
    if (previous) {
      const prevJsonl = previous.mainFile.path.endsWith('.jsonl');
      const nextJsonl = session.mainFile.path.endsWith('.jsonl');
      if (prevJsonl && !nextJsonl) return;
      if (prevJsonl === nextJsonl) {
        if (
          previous.mainFile.size > session.mainFile.size ||
          (previous.mainFile.size === session.mainFile.size && previous.mainFile.mtimeMs >= session.mainFile.mtimeMs)
        ) {
          return;
        }
      }
      this.sessions.splice(this.sessions.indexOf(previous), 1);
    }
    this.ids.set(session.sessionId, session);
    this.sessions.push(session);
  }
}

interface GeminiCliHeader {
  sessionId?: string;
  parentSessionId?: string;
  projectHash?: string;
  cwd?: string;
}

async function readGeminiCliHeader(filePath: string): Promise<GeminiCliHeader | undefined> {
  if (filePath.endsWith('.json')) {
    const raw = asRecord(parseJson(await readFile(filePath, 'utf8')));
    return raw ? extractHeader(raw) : undefined;
  }
  for await (const line of readJsonlLines(filePath)) {
    if (!line.text.trim()) continue;
    const raw = asRecord(parseJson(line.text));
    if (raw) return extractHeader(raw);
    if (line.seq >= 5) break;
  }
  return undefined;
}

function extractHeader(raw: Record<string, unknown>): GeminiCliHeader {
  const header: GeminiCliHeader = {};
  const sessionId = str(raw, 'sessionId');
  const parentSessionId = str(raw, 'parentSessionId');
  const projectHash = str(raw, 'projectHash');
  const dirs = Array.isArray(raw['directories']) ? raw['directories'] : [];
  const cwd = str(raw, 'cwd') ?? str(raw, 'projectPath') ?? (typeof dirs[0] === 'string' && path.isAbsolute(dirs[0]) ? dirs[0] : undefined);
  if (sessionId) header.sessionId = sessionId;
  if (parentSessionId) header.parentSessionId = parentSessionId;
  if (projectHash) header.projectHash = projectHash;
  if (cwd) header.cwd = cwd;
  return header;
}

function inferAntigravityConversationId(logsDir: string): string {
  const sysDir = path.dirname(logsDir);
  if (path.basename(sysDir) === '.system_generated') return path.basename(path.dirname(sysDir));
  return path.basename(logsDir);
}

async function isDir(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function hasGeminiHomeLayout(root: string): Promise<boolean> {
  if (await isDir(path.join(root, 'tmp'))) {
    if ((await isFile(path.join(root, 'projects.json'))) || (await hasGeminiCliLayout(path.join(root, 'tmp')))) {
      return true;
    }
  }
  for (const appDir of ANTIGRAVITY_APP_DIRS) {
    if (await isDir(path.join(root, appDir, 'brain'))) return true;
  }
  return false;
}

async function hasAntigravityTranscriptFile(dir: string): Promise<boolean> {
  return (await isFile(path.join(dir, 'transcript_full.jsonl'))) || (await isFile(path.join(dir, 'transcript.jsonl')));
}

async function hasAntigravityConversationLayout(root: string): Promise<boolean> {
  if (await isDir(path.join(root, '.system_generated', 'logs'))) return true;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (await isDir(path.join(root, entry.name, '.system_generated', 'logs'))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function hasGeminiCliLayout(root: string): Promise<boolean> {
  const base = path.basename(root);
  if (base === 'chats') {
    if (await isFile(path.join(path.dirname(root), '.project_root'))) return true;
  }
  try {
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.some((e) => (e.isFile() || e.isSymbolicLink()) && GEMINI_SESSION_FILE.test(e.name))) return true;
    if (
      entries.some((e) => e.name === '.project_root') &&
      entries.some((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name === 'chats')
    ) {
      return true;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const projDir = path.join(root, entry.name);
      if (await isFile(path.join(projDir, '.project_root'))) return true;
      const chatsDir = path.join(projDir, 'chats');
      if (await isDir(chatsDir)) {
        const chatFiles = await readdir(chatsDir).catch(() => []);
        if (chatFiles.some((name) => GEMINI_SESSION_FILE.test(name))) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export async function isGeminiRoot(root: string): Promise<boolean> {
  const base = path.basename(root);
  if (
    base === '.gemini' ||
    base === 'brain' ||
    (ANTIGRAVITY_APP_DIRS as readonly string[]).includes(base) ||
    /[\\/]\.gemini[\\/](?:tmp|antigravity(?:-cli|-ide)?(?:[\\/]brain)?)$/.test(root)
  ) {
    return true;
  }
  if (await hasGeminiHomeLayout(root)) return true;
  if (await isDir(path.join(root, 'brain'))) return true;
  if (await hasAntigravityTranscriptFile(root)) return true;
  if (await hasAntigravityConversationLayout(root)) return true;
  return await hasGeminiCliLayout(root);
}

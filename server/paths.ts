/**
 * Resolves CCA_HOME (the app's own data directory) and the paths inside it, plus the
 * transcript roots to index. Ensures directories/files have restrictive permissions since
 * the DB and config may contain (derived) cost data for the user's private transcripts.
 */
import { copilotRoots, copilotEditorRoots } from './copilot-paths.js';
import { existsSync, mkdirSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

const DEFAULT_HOME_DIRNAME = '.claude-cost-analyzer';
const DEFAULT_ROOT = '~/.claude/projects';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Expands a leading `~` (or `~/…`) to the current user's home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export interface ResolvedPaths {
  /** CCA_HOME: directory holding index.sqlite and config.json */
  home: string;
  dbPath: string;
  configPath: string;
}

export interface ResolvePathsOptions {
  /** --home flag; falls back to CCA_HOME env; falls back to ~/.claude-cost-analyzer */
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolves CCA_HOME and the file paths inside it. Does not touch the filesystem. */
export function resolvePaths(opts: ResolvePathsOptions = {}): ResolvedPaths {
  const env = opts.env ?? process.env;
  const rawHome = opts.home ?? env.CCA_HOME ?? join('~', DEFAULT_HOME_DIRNAME);
  const home = resolve(expandHome(rawHome));
  return {
    home,
    dbPath: join(home, 'index.sqlite'),
    configPath: join(home, 'config.json'),
  };
}

/** Creates CCA_HOME with mode 0700 if missing; tightens permissions if it already exists. */
export function ensureHomeDir(home: string): void {
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: DIR_MODE });
  }
  try {
    chmodSync(home, DIR_MODE);
  } catch {
    // best-effort on filesystems that don't support unix permission bits (unusual for CCA_HOME)
  }
}

/** Tightens a file inside CCA_HOME to mode 0600 after it has been written. */
export function ensureFileMode(path: string): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // best-effort; see ensureHomeDir
  }
}

export interface ResolveRootsOptions {
  /** roots from UserSettings, already persisted */
  settingsRoots?: string[];
  /** --claude-dir CLI flag */
  claudeDirFlag?: string;
  /** --codex-dir CLI flag: Codex home or a sessions/archived_sessions directory */
  codexDirFlag?: string;
  /** Copilot home/session-state or VS Code transcript root. */
  copilotDirFlag?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Explicit Claude/Codex selections override configured roots and may be combined.
 * Without overrides, the legacy default adds Codex session roots honoring CODEX_HOME.
 * Custom settings roots remain unchanged. Results are absolute and `~`-expanded.
 */
export function resolveRoots(opts: ResolveRootsOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const claude = opts.claudeDirFlag ?? env.CCA_CLAUDE_DIR;
  const codex = opts.codexDirFlag ?? env.CCA_CODEX_DIR;
  const copilot = opts.copilotDirFlag ?? env.CCA_COPILOT_DIR;
  // An explicit source selection stays isolated (including fixtures and demo runs).
  if (claude || codex || copilot) {
    return [...new Set([
      ...(claude ? [resolve(expandHome(claude))] : []),
      ...(codex ? codexRoots(codex) : []),
      ...(copilot ? selectedCopilotRoots(copilot) : []),
    ])];
  }
  const configured = opts.settingsRoots?.length ? opts.settingsRoots : [DEFAULT_ROOT];
  // Upgrade only the legacy default, preserving deliberately configured custom roots.
  const roots = configured.length === 1 && resolve(expandHome(configured[0]!)) === resolve(expandHome(DEFAULT_ROOT))
    ? [...configured, ...codexRoots(env.CODEX_HOME ?? '~/.codex'), ...copilotRoots(expandHome(env.COPILOT_HOME ?? '~/.copilot'))]
    : configured;
  const resolved = roots.map((r) => {
    if (env.CODEX_HOME && (r === '~/.codex/sessions' || r === '~/.codex/archived_sessions')) {
      return resolve(expandHome(join(env.CODEX_HOME, r.endsWith('/sessions') ? 'sessions' : 'archived_sessions')));
    }
    if (env.COPILOT_HOME && r === '~/.copilot/session-state') return join(resolve(expandHome(env.COPILOT_HOME)), 'session-state');
    return resolve(expandHome(r));
  });
  const standardRoots = [DEFAULT_ROOT, '~/.codex/sessions', '~/.codex/archived_sessions', '~/.copilot/session-state'];
  const defaultSelection = configured.length === 1 && configured[0] === DEFAULT_ROOT || configured.length === standardRoots.length && configured.every((root, i) => root === standardRoots[i]);
  if (defaultSelection) resolved.push(...copilotEditorRoots(env));
  return [...new Set(resolved)];
}

/** Restrict a Codex home to its transcript directories; never walk auth/config files. */
export function codexRoots(directory: string): string[] {
  const root = resolve(expandHome(directory));
  const leaf = root.split(sep).at(-1);
  if (leaf === 'sessions' || leaf === 'archived_sessions') return [root];
  try {
    // A user may point at an exported or dated rollout folder rather than a Codex home.
    if (readdirSync(root).some(name => /^rollout-.*\.jsonl$/.test(name))) return [root];
  } catch { /* A not-yet-created Codex home still resolves to its known transcript roots. */ }
  return [join(root, 'sessions'), join(root, 'archived_sessions')];
}

/** True when `child` is `dir` or a path inside it, after normalization (guards path traversal). */
export function isInside(dir: string, child: string): boolean {
  const normalizedDir = resolve(dir);
  const normalizedChild = resolve(child);
  if (normalizedChild === normalizedDir) return true;
  return normalizedChild.startsWith(normalizedDir.endsWith(sep) ? normalizedDir : normalizedDir + sep);
}

/** Directory existence check that never throws (used by the watcher to skip missing roots). */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isAbsolutePath(path: string): boolean {
  return isAbsolute(path);
}

function selectedCopilotRoots(directory: string): string[] {
  const root = resolve(expandHome(directory));
  const leaf = root.split(sep).at(-1);
  if (existsSync(join(root, 'workspaceStorage')) || ['User', 'workspaceStorage', 'globalStorage', 'chatSessions', 'emptyWindowChatSessions'].includes(leaf ?? '') || existsSync(join(root, 'chatSessions'))) return [root];
  return copilotRoots(root);
}

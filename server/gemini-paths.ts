/**
 * Known local Google Gemini CLI and Google Antigravity transcript locations.
 * Only `tmp` (Gemini CLI chats) and `antigravity/brain` (`antigravity-cli/brain`, `antigravity-ide/brain`)
 * are selected; OAuth credentials, account files, MCP configs and settings are never scanned.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const ANTIGRAVITY_DIRS = ['antigravity', 'antigravity-cli', 'antigravity-ide'] as const;

function expand(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(2));
  return raw;
}

/** `GEMINI_CLI_HOME` moves the parent home directory containing `.gemini` (or points to `.gemini` itself). */
export function defaultGeminiDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.GEMINI_CLI_HOME) {
    const custom = resolve(expand(env.GEMINI_CLI_HOME, home));
    return basename(custom) === '.gemini' ? custom : join(custom, '.gemini');
  }
  return join(home, '.gemini');
}

export function geminiTranscriptRoots(geminiDir: string): string[] {
  return [
    join(geminiDir, 'tmp'),
    ...ANTIGRAVITY_DIRS.map((dir) => join(geminiDir, dir, 'brain')),
  ];
}

/** Auto-detect existing Gemini CLI and Antigravity transcript roots without warning when uninstalled. */
export function geminiDefaultRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return geminiTranscriptRoots(defaultGeminiDir(env, home)).filter(existsSync);
}

/** Restrict an explicit `--gemini-dir` / `CCA_GEMINI_DIR` selection to safe transcript subdirectories. */
export function selectedGeminiRoots(directory: string, home = homedir()): string[] {
  const root = resolve(expand(directory, home));
  const leaf = basename(root);
  if (
    leaf === '.gemini' ||
    ANTIGRAVITY_DIRS.some((dir) => existsSync(join(root, dir))) ||
    (existsSync(join(root, 'tmp')) && existsSync(join(root, 'projects.json')))
  ) {
    const candidates = geminiTranscriptRoots(root);
    const present = candidates.filter(existsSync);
    return present.length > 0 ? present : candidates.slice(0, 3);
  }
  if ((ANTIGRAVITY_DIRS as readonly string[]).includes(leaf) || existsSync(join(root, 'brain'))) {
    return [join(root, 'brain')];
  }
  if (existsSync(join(root, 'tmp'))) {
    return [join(root, 'tmp')];
  }
  return [root];
}

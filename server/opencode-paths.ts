/** Known local OpenCode data location. Only `opencode.db` inside it is ever opened; auth files are not scanned. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';

/** OpenCode follows XDG on every platform: `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. */
export function defaultOpenCodeDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(home, '.local/share'), 'opencode');
}

/** An explicit selection may be the data directory or the database file itself. */
export function selectedOpenCodeRoots(path: string): string[] {
  return [resolve(path)];
}

/** Only an existing database is auto-detected; explicit missing sources remain visible. */
export function openCodeDefaultRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dir = defaultOpenCodeDir(env, home);
  try { return statSync(join(dir, 'opencode.db')).isFile() ? [dir] : []; } catch { return []; }
}

export function hasOpenCodeDatabase(root: string): boolean {
  return existsSync(join(root, 'opencode.db'));
}

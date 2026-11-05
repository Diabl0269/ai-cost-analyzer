/** Known local Copilot transcript locations. No credential/config files are scanned. */
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';

export function copilotRoots(directory: string): string[] {
  const root = resolve(directory);
  if (basename(root) === 'session-state' || existsSync(join(root, 'events.jsonl'))) return [root];
  return [join(root, 'session-state')];
}

/** Only existing editor stores are auto-detected; explicit missing sources remain visible. */
export function copilotEditorRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  const base = platform === 'darwin' ? join(home, 'Library/Application Support')
    : platform === 'win32' ? env.APPDATA ?? join(home, 'AppData/Roaming')
    : env.XDG_CONFIG_HOME ?? join(home, '.config');
  const users = ['Code', 'Code - Insiders', 'VSCodium'].map(name => join(base, name, 'User'));
  users.push(join(home, '.vscode-server/data/User'), join(home, '.vscode-server-insiders/data/User'));
  return users.flatMap(user => [join(user, 'workspaceStorage'), join(user, 'globalStorage/emptyWindowChatSessions')]).filter(existsSync);
}

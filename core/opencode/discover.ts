/** OpenCode discovery opens only `opencode.db`; it never lists or reads credential/config files. */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveredSession } from '../types.js';
import type { DiscoveryWarning } from '../discover.js';
import { OPENCODE_DB_NAME, listOpenCodeSessions, openCodeFilePath } from './db.js';

export class OpenCodeScan {
  readonly sessions: DiscoveredSession[] = [];
  readonly warnings: DiscoveryWarning[] = [];
  private readonly databases = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly ids = new Map<string, DiscoveredSession>();

  async scan(root: string): Promise<void> {
    const dbPath = await databaseOf(root);
    if (!dbPath || this.databases.has(dbPath)) return;
    this.databases.add(dbPath);
    try {
      for (const row of listOpenCodeSessions(dbPath)) {
        const sessionId = `opencode-${row.id}`;
        const cwd = row.directory;
        const projectDirName = cwd ? `opencode-project-${Buffer.from(cwd).toString('base64url')}` : `opencode-unknown-${row.id}`;
        const filePath = openCodeFilePath(dbPath, row.id);
        if (row.parentId) this.parents.set(sessionId, `opencode-${row.parentId}`);
        const session: DiscoveredSession = {
          provider: 'opencode', projectDirName, projectDirPath: cwd ?? path.dirname(dbPath), sessionId,
          mainFile: { provider: 'opencode', path: filePath, size: row.size, mtimeMs: row.updated, kind: 'main', projectDirName, sessionId },
          agentFiles: [], workflowRuns: [],
        };
        this.ids.set(sessionId, session);
        this.sessions.push(session);
      }
    } catch {
      this.warnings.push({ path: dbPath, message: 'OpenCode database is unreadable' });
    }
  }

  /** Child sessions (subagents) are folded into their discovered top-level ancestor. */
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
      owner.agentFiles.push({ ...session.mainFile, kind: 'subagent', sessionId: owner.sessionId, agentId: session.sessionId.slice('opencode-'.length) });
    }
    return this.sessions.filter((session) => !children.has(session.sessionId));
  }
}

async function isFile(target: string): Promise<boolean> {
  try { return (await stat(target)).isFile(); } catch { return false; }
}

/** A root is either an OpenCode data directory or the database file itself. */
async function databaseOf(root: string): Promise<string | undefined> {
  if (await isFile(root)) return root.endsWith('.db') ? root : undefined;
  const candidate = path.join(root, OPENCODE_DB_NAME);
  return (await isFile(candidate)) ? candidate : undefined;
}

export async function isOpenCodeRoot(root: string): Promise<boolean> {
  return (await databaseOf(root)) !== undefined;
}

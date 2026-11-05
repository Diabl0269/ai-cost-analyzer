/** Codex rollout discovery is limited to its home, archive and YYYY/MM/DD layouts. */
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readJsonlLines } from '../jsonl.js';
import { asRecord, rec, str, parseJson } from '../parse/raw.js';
import type { DiscoveredSession } from '../types.js';
import type { DiscoveryWarning } from '../discover.js';

export class CodexScan {
  readonly sessions: DiscoveredSession[] = [];
  readonly warnings: DiscoveryWarning[] = [];
  private readonly directories = new Set<string>();
  private readonly files = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly ids = new Map<string, DiscoveredSession>();

  async scan(root: string): Promise<void> {
    try {
      const canonical = await realpath(root);
      if (this.directories.has(canonical)) return;
      this.directories.add(canonical);
      const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1);
      for (const entry of entries) {
        const target = path.join(root, entry.name);
        if (/^rollout-.*\.jsonl$/.test(entry.name)) {
          if (entry.isFile() || entry.isSymbolicLink()) await this.file(target);
        } else if (/^(sessions|archived_sessions|\d{4}|\d{2})$/.test(entry.name)) {
          if (entry.isDirectory() || entry.isSymbolicLink()) await this.scan(target);
        }
      }
    } catch {
      this.warnings.push({ path: root, message: 'Codex transcript directory is unreadable' });
    }
  }

  finish(): DiscoveredSession[] {
    // Attach a child once, directly to its discovered top-level ancestor. Orphan children remain
    // visible sessions so scanning a partial archive never silently loses their usage.
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
      if (!owner || parentId && visited.has(parentId)) continue;
      children.add(session.sessionId);
      owner.agentFiles.push({ ...session.mainFile, kind: 'subagent', sessionId: owner.sessionId, agentId: session.sessionId.slice('codex-'.length) });
    }
    return this.sessions.filter((session) => !children.has(session.sessionId));
  }

  private async file(filePath: string): Promise<void> {
    try {
      const canonical = await realpath(filePath);
      if (this.files.has(canonical)) return;
      this.files.add(canonical);
      let metadata: Record<string, unknown> | undefined;
      for await (const line of readJsonlLines(filePath)) {
        const raw = asRecord(parseJson(line.text));
        if (raw?.['type'] === 'session_meta') { metadata = rec(raw, 'payload'); break; }
        if (line.seq >= 19) break;
      }
      const id = str(metadata, 'id') ?? str(metadata, 'session_id');
      if (!id) {
        this.warnings.push({ path: filePath, message: 'Codex rollout has no session metadata id' });
        return;
      }
      const sessionId = `codex-${id}`;
      const source = rec(metadata, 'source');
      const spawn = rec(rec(source, 'subagent'), 'thread_spawn');
      const parentId = str(metadata, 'parent_thread_id') ?? str(spawn, 'parent_thread_id');
      if (parentId) this.parents.set(sessionId, `codex-${parentId}`);
      const cwd = str(metadata, 'cwd');
      const projectDirName = cwd ? `codex-project-${Buffer.from(cwd).toString('base64url')}` : `codex-unknown-${id}`;
      const s = await stat(filePath);
      const session: DiscoveredSession = {
        provider: 'codex', projectDirName, projectDirPath: cwd ?? path.dirname(filePath), sessionId,
        mainFile: { provider: 'codex', path: filePath, size: s.size, mtimeMs: s.mtimeMs, kind: 'main', projectDirName, sessionId },
        agentFiles: [], workflowRuns: [],
      };
      // Copies of the same session can exist in both active and archived roots. Prefer the more
      // complete copy, then latest mtime, independently of the root scan order.
      const previous = this.ids.get(sessionId);
      if (previous) {
        if (previous.mainFile.size > s.size || (previous.mainFile.size === s.size && previous.mainFile.mtimeMs >= s.mtimeMs)) return;
        this.sessions.splice(this.sessions.indexOf(previous), 1);
      }
      this.ids.set(sessionId, session);
      this.sessions.push(session);
    } catch {
      this.warnings.push({ path: filePath, message: 'Codex rollout is unreadable' });
    }
  }
}

export async function isCodexRoot(root: string): Promise<boolean> {
  if (['.codex', 'sessions', 'archived_sessions'].includes(path.basename(root)) || /[\\/](?:sessions|archived_sessions)(?:[\\/]\d{2,4})+$/.test(root)) return true;
  try {
    const entries = await readdir(root);
    return entries.includes('sessions') || entries.includes('archived_sessions') || entries.some((name) => /^rollout-.*\.jsonl$/.test(name));
  } catch { return false; }
}

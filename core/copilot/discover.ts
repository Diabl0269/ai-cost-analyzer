/** Read only Copilot's session-state/<session>/events.jsonl, never config/auth files. */
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readJsonlLines } from '../jsonl.js';
import { asRecord, parseJson, rec, str } from '../parse/raw.js';
import type { DiscoveredSession } from '../types.js';
import type { DiscoveryWarning } from '../discover.js';

export class CopilotScan {
  readonly sessions: DiscoveredSession[] = [];
  readonly warnings: DiscoveryWarning[] = [];
  private readonly directories = new Set<string>();
  private readonly files = new Set<string>();
  private readonly ids = new Map<string, DiscoveredSession>();

  async scan(root: string): Promise<void> {
    try {
      const canonical = await realpath(root);
      if (this.directories.has(canonical)) return;
      this.directories.add(canonical);
      const entries = await readdir(canonical, { withFileTypes: true });
      if (entries.some((entry) => entry.name === 'session-state' && entry.isDirectory())) {
        await this.scan(path.join(canonical, 'session-state'));
      } else if (path.basename(root) === 'session-state') {
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isDirectory()) await this.file(path.join(canonical, entry.name, 'events.jsonl'));
        }
      } else if (entries.some((entry) => entry.name === 'events.jsonl' && entry.isFile())) {
        await this.file(path.join(canonical, 'events.jsonl'));
      }
    } catch {
      this.warnings.push({ path: root, message: 'Copilot transcript directory is unreadable' });
    }
  }

  finish(): DiscoveredSession[] { return this.sessions; }

  private async file(filePath: string): Promise<void> {
    try {
      const canonical = await realpath(filePath);
      // Do not follow an events.jsonl symlink into credentials or arbitrary JSONL files.
      if (canonical !== path.resolve(filePath)) return;
      if (this.files.has(canonical)) return;
      this.files.add(canonical);
      let metadata: Record<string, unknown> | undefined;
      for await (const line of readJsonlLines(filePath)) {
        const raw = asRecord(parseJson(line.text));
        if (raw?.['type'] === 'session.start') { metadata = rec(raw, 'data'); break; }
        if (line.seq >= 99) break;
      }
      const id = str(metadata, 'sessionId');
      if (!id) {
        this.warnings.push({ path: filePath, message: 'Copilot transcript has no session.start id' });
        return;
      }
      const cwd = str(rec(metadata, 'context'), 'cwd') ?? str(metadata, 'cwd');
      const sessionId = `copilot-${id}`;
      const projectDirName = cwd ? `copilot-project-${Buffer.from(cwd).toString('base64url')}` : `copilot-unknown-${id}`;
      const s = await stat(filePath);
      const session: DiscoveredSession = {
        provider: 'copilot', projectDirName, projectDirPath: cwd ?? path.dirname(filePath), sessionId,
        mainFile: { provider: 'copilot', path: filePath, size: s.size, mtimeMs: s.mtimeMs, kind: 'main', projectDirName, sessionId },
        agentFiles: [], workflowRuns: [],
      };
      const previous = this.ids.get(sessionId);
      if (previous) {
        if (previous.mainFile.size > s.size || previous.mainFile.size === s.size && previous.mainFile.mtimeMs >= s.mtimeMs) return;
        this.sessions.splice(this.sessions.indexOf(previous), 1);
      }
      this.ids.set(sessionId, session);
      this.sessions.push(session);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warnings.push({ path: filePath, message: 'Copilot transcript is unreadable' });
    }
  }
}

export async function isCopilotRoot(root: string): Promise<boolean> {
  if (['.copilot', 'session-state'].includes(path.basename(root))) return true;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.some((entry) => entry.name === 'session-state' && entry.isDirectory() || entry.name === 'events.jsonl' && entry.isFile());
  } catch { return false; }
}

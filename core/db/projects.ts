/**
 * Project derivation (SPEC §4). A project is one `~/.claude/projects/<dirName>` directory; its
 * display path is the most common `cwd` among its sessions, because the directory name is a lossy
 * encoding of the path.
 */
import type { DatabaseSync } from 'node:sqlite';
import { num, str, type Row } from './rows.js';

const WORKTREE_MARKER = '/.claude/worktrees/';
const SCRATCH_PREFIXES = ['/private/var/folders', '/private/tmp', '/tmp', '/var/folders'];

export function isScratchPath(path: string): boolean {
  return SCRATCH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** `/repo/.claude/worktrees/feature` → `/repo`; `null` when the path is not a worktree. */
export function worktreeParent(path: string): string | null {
  const at = path.indexOf(WORKTREE_MARKER);
  return at > 0 ? path.slice(0, at) : null;
}

/** Decodes a `~/.claude/projects` directory name back to a path (lossy: `-` was both `/` and `-`). */
export function decodeProjectDirName(dirName: string): string {
  return dirName.startsWith('-') ? dirName.replace(/-/g, '/') : dirName;
}

export function displayNameOf(path: string): string {
  const parent = worktreeParent(path);
  if (parent) {
    const branch = path.slice(parent.length + WORKTREE_MARKER.length);
    return `${basename(parent)} · ${branch}`;
  }
  return basename(path);
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  return at >= 0 ? trimmed.slice(at + 1) || trimmed : trimmed;
}

/**
 * Rebuilds the `projects` table from the sessions currently indexed. Cheap (one grouped scan) and
 * run at the end of every index pass so incremental updates cannot leave a stale display path.
 */
export function refreshProjects(db: DatabaseSync): void {
  // A folder is shared across providers. Keep an existing Claude project id where possible so
  // saved project links continue to work; never use the lossy directory encoding to merge paths.
  const folders = db.prepare(`SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != ''`).all() as Row[];
  const canonical = db.prepare(`SELECT projectId FROM sessions WHERE cwd = ?
    ORDER BY CASE WHEN provider = 'claude' THEN 0 ELSE 1 END, projectId LIMIT 1`);
  const merge = db.prepare('UPDATE sessions SET projectId = ? WHERE cwd = ?');
  for (const folder of folders) {
    const cwd = str(folder, 'cwd');
    const project = canonical.get(cwd) as Row | undefined;
    if (project) merge.run(str(project, 'projectId'), cwd);
  }

  const rows = db
    .prepare(
      `SELECT projectId, COALESCE(cwd, '') AS cwd, COUNT(*) AS n
       FROM sessions GROUP BY projectId, COALESCE(cwd, '') ORDER BY projectId, n DESC`,
    )
    .all() as Row[];
  const best = new Map<string, { cwd: string; n: number }>();
  for (const row of rows) {
    const projectId = str(row, 'projectId');
    const cwd = str(row, 'cwd');
    const n = num(row, 'n');
    const current = best.get(projectId);
    if (cwd.length === 0) {
      if (!current) best.set(projectId, { cwd: '', n });
      continue;
    }
    if (!current || current.cwd.length === 0 || n > current.n) best.set(projectId, { cwd, n });
  }

  db.exec('DELETE FROM projects WHERE id NOT IN (SELECT DISTINCT projectId FROM sessions)');
  const upsert = db.prepare(
    `INSERT INTO projects (id, dirName, path, displayName, parentPath, isWorktree, isScratch)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET path = excluded.path, displayName = excluded.displayName,
       parentPath = excluded.parentPath, isWorktree = excluded.isWorktree, isScratch = excluded.isScratch`,
  );
  for (const [projectId, { cwd }] of best) {
    const path = cwd.length > 0 ? cwd : decodeProjectDirName(projectId);
    const parent = worktreeParent(path);
    upsert.run(
      projectId,
      projectId,
      path,
      displayNameOf(path),
      parent,
      parent ? 1 : 0,
      isScratchPath(path) ? 1 : 0,
    );
  }
}

/**
 * Read-only access to Google Antigravity's local `conversation_summaries.db`.
 * Only summary metadata (`conversation_summaries`, `conversation_parents`) is queried;
 * settings, MCP configs, and OAuth/account files are never opened.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseJson } from '../parse/raw.js';

export const ANTIGRAVITY_SUMMARIES_DB = 'conversation_summaries.db';

export interface AntigravitySummaryRow {
  conversationId: string;
  title?: string;
  cwd?: string;
  agentName?: string;
  parentId?: string;
  appDataDir?: string;
}

function openReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 2000');
  return db;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function workspaceUriToPath(raw: unknown): string | undefined {
  const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
  const list = Array.isArray(parsed) ? parsed : typeof raw === 'string' ? [raw] : [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const trimmed = item.trim();
    if (trimmed.startsWith('file://')) {
      try {
        return fileURLToPath(trimmed);
      } catch {
        // Fall through to next URI if malformed.
      }
    } else if (path.isAbsolute(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

export function readAntigravitySummaries(dbPath: string): Map<string, AntigravitySummaryRow> {
  const out = new Map<string, AntigravitySummaryRow>();
  if (!existsSync(dbPath)) return out;
  const db = openReadOnly(dbPath);
  try {
    const tables = tableNames(db);
    const parentLinks = new Map<string, string>();
    if (tables.has('conversation_parents')) {
      const rows = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all() as Record<string, unknown>[];
      for (const row of rows) {
        const id = nonEmpty(row['conversation_id']);
        const parent = nonEmpty(row['parent_id']);
        if (id && parent) parentLinks.set(id, parent);
      }
    }
    if (tables.has('conversation_summaries')) {
      const rows = db
        .prepare(
          'SELECT conversation_id, title, workspace_uris, agent_name, parent_conversation_id, app_data_dir FROM conversation_summaries',
        )
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        const conversationId = nonEmpty(row['conversation_id']);
        if (!conversationId) continue;
        const entry: AntigravitySummaryRow = { conversationId };
        const title = nonEmpty(row['title']);
        const cwd = workspaceUriToPath(row['workspace_uris']);
        const agentName = nonEmpty(row['agent_name']);
        const parentId = nonEmpty(row['parent_conversation_id']) ?? parentLinks.get(conversationId);
        const appDataDir = nonEmpty(row['app_data_dir']);
        if (title) entry.title = title;
        if (cwd) entry.cwd = cwd;
        if (agentName) entry.agentName = agentName;
        if (parentId) entry.parentId = parentId;
        if (appDataDir) entry.appDataDir = appDataDir;
        out.set(conversationId, entry);
      }
    }
    for (const [id, parentId] of parentLinks) {
      if (!out.has(id)) out.set(id, { conversationId: id, parentId });
    }
    return out;
  } catch {
    return out;
  } finally {
    db.close();
  }
}

/**
 * Given `<antigravity-dir>/brain/<conversation-id>/.system_generated/logs/transcript*.jsonl`,
 * locate the sibling `conversation_summaries.db` (if present) and read that conversation's metadata.
 */
export function loadAntigravitySummaryForTranscript(
  filePath: string,
  conversationId: string,
): AntigravitySummaryRow | undefined {
  // Walk up from `.../brain/<id>/.system_generated/logs/<file>` to `<antigravity-dir>`.
  const logsDir = path.dirname(filePath);
  const sysDir = path.dirname(logsDir);
  const convDir = path.dirname(sysDir);
  const brainDir = path.dirname(convDir);
  const appDir = path.basename(brainDir) === 'brain' ? path.dirname(brainDir) : brainDir;
  const dbPath = path.join(appDir, ANTIGRAVITY_SUMMARIES_DB);
  if (!existsSync(dbPath)) return undefined;
  const db = openReadOnly(dbPath);
  try {
    const tables = tableNames(db);
    let parentFromLink: string | undefined;
    if (tables.has('conversation_parents')) {
      const link = db
        .prepare('SELECT parent_id FROM conversation_parents WHERE conversation_id = ?')
        .get(conversationId) as Record<string, unknown> | undefined;
      parentFromLink = nonEmpty(link?.['parent_id']);
    }
    if (!tables.has('conversation_summaries')) {
      return parentFromLink ? { conversationId, parentId: parentFromLink } : undefined;
    }
    const row = db
      .prepare(
        'SELECT conversation_id, title, workspace_uris, agent_name, parent_conversation_id, app_data_dir FROM conversation_summaries WHERE conversation_id = ?',
      )
      .get(conversationId) as Record<string, unknown> | undefined;
    if (!row) return parentFromLink ? { conversationId, parentId: parentFromLink } : undefined;
    const entry: AntigravitySummaryRow = { conversationId };
    const title = nonEmpty(row['title']);
    const cwd = workspaceUriToPath(row['workspace_uris']);
    const agentName = nonEmpty(row['agent_name']);
    const parentId = nonEmpty(row['parent_conversation_id']) ?? parentFromLink;
    const appDataDir = nonEmpty(row['app_data_dir']);
    if (title) entry.title = title;
    if (cwd) entry.cwd = cwd;
    if (agentName) entry.agentName = agentName;
    if (parentId) entry.parentId = parentId;
    if (appDataDir) entry.appDataDir = appDataDir;
    return entry;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

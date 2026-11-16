/**
 * Read-only access to OpenCode's local SQLite store (`<data dir>/opencode.db`).
 *
 * Two layouts exist: the original `session` / `message` / `part` tables (JSON `data` columns) and
 * the newer `session_v2` / `session_message` / `session_part` tables, where assistant messages carry
 * their content inline. Only these tables are read; credential, account and config tables in the
 * same file are never queried.
 */
import { DatabaseSync } from 'node:sqlite';
import { asRecord, count, list, num, parseJson, rec, str } from '../parse/raw.js';

export const OPENCODE_DB_NAME = 'opencode.db';
/** Virtual transcript path: `<db path>#opencode:<raw session id>`. */
const SEPARATOR = '#opencode:';

export function openCodeFilePath(dbPath: string, sessionId: string): string {
  return `${dbPath}${SEPARATOR}${sessionId}`;
}

export function splitOpenCodePath(filePath: string): { dbPath: string; sessionId: string } | undefined {
  const at = filePath.lastIndexOf(SEPARATOR);
  if (at < 0) return undefined;
  return { dbPath: filePath.slice(0, at), sessionId: filePath.slice(at + SEPARATOR.length) };
}

export function isOpenCodePath(filePath: string): boolean {
  return filePath.includes(SEPARATOR);
}

export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OpenCodePart {
  kind: 'text' | 'reasoning' | 'tool';
  text?: string;
  callId?: string;
  name?: string;
  input?: unknown;
  output?: string;
  status?: string;
  ts?: number;
}

export interface OpenCodeMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  created: number;
  model?: string;
  variant?: string;
  tokens?: OpenCodeTokens;
  text?: string;
  parts: OpenCodePart[];
  finish?: string;
  error?: string;
  cwd?: string;
}

export interface OpenCodeSessionRow {
  id: string;
  parentId?: string;
  directory?: string;
  title?: string;
  version?: string;
  created: number;
  /** Cheap change fingerprint: bytes of stored message data, and the latest update time. */
  size: number;
  updated: number;
}

export interface OpenCodeSession extends OpenCodeSessionRow {
  messages: OpenCodeMessage[];
}

type Layout = { session: string; message: string; part?: string; inline: boolean };
const LAYOUTS: Layout[] = [
  { session: 'session', message: 'message', part: 'part', inline: false },
  { session: 'session_v2', message: 'session_message', inline: true },
];

function open(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 2000');
  return db;
}

function layoutsIn(db: DatabaseSync): Layout[] {
  const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
  return LAYOUTS.filter((layout) => names.has(layout.session) && names.has(layout.message));
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function listOpenCodeSessions(dbPath: string): OpenCodeSessionRow[] {
  const db = open(dbPath);
  try {
    const rows = new Map<string, OpenCodeSessionRow>();
    for (const layout of layoutsIn(db)) {
      const messages = new Map<string, { bytes: number; updated: number }>();
      for (const row of db.prepare(`SELECT session_id AS id, SUM(LENGTH(data)) AS bytes, MAX(time_updated) AS updated FROM ${layout.message} GROUP BY session_id`).all() as Record<string, unknown>[]) {
        messages.set(String(row['id']), { bytes: count(row['bytes']), updated: count(row['updated']) });
      }
      if (layout.part) {
        for (const row of db.prepare(`SELECT session_id AS id, SUM(LENGTH(data)) AS bytes, MAX(time_updated) AS updated FROM ${layout.part} GROUP BY session_id`).all() as Record<string, unknown>[]) {
          const previous = messages.get(String(row['id'])) ?? { bytes: 0, updated: 0 };
          messages.set(String(row['id']), { bytes: previous.bytes + count(row['bytes']), updated: Math.max(previous.updated, count(row['updated'])) });
        }
      }
      for (const row of db.prepare(`SELECT id, parent_id, directory, title, version, time_created, time_updated FROM ${layout.session}`).all() as Record<string, unknown>[]) {
        const id = String(row['id']);
        const seen = messages.get(id);
        const entry: OpenCodeSessionRow = {
          id, created: count(row['time_created']), size: seen?.bytes ?? 0,
          updated: Math.max(count(row['time_updated']), seen?.updated ?? 0),
        };
        const parentId = nonEmpty(row['parent_id']);
        const directory = nonEmpty(row['directory']);
        const title = nonEmpty(row['title']);
        const version = nonEmpty(row['version']);
        if (parentId) entry.parentId = parentId;
        if (directory) entry.directory = directory;
        if (title) entry.title = title;
        if (version) entry.version = version;
        rows.set(id, entry);
      }
    }
    return [...rows.values()];
  } finally {
    db.close();
  }
}

function tokensOf(raw: Record<string, unknown> | undefined): OpenCodeTokens | undefined {
  if (!raw) return undefined;
  const cache = rec(raw, 'cache');
  return {
    input: count(raw['input']), output: count(raw['output']), reasoning: count(raw['reasoning']),
    cacheRead: count(cache?.['read']), cacheWrite: count(cache?.['write']),
  };
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => (typeof item === 'string' ? item : str(asRecord(item), 'text') ?? '')).filter(Boolean).join('\n');
}

function errorOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return str(record, 'message') ?? str(rec(record, 'data'), 'message') ?? (record ? str(record, 'name') : undefined);
}

function toolPart(raw: Record<string, unknown>, ts: number | undefined): OpenCodePart {
  const state = rec(raw, 'state');
  const status = str(state, 'status');
  const output = textOf(state?.['output'] ?? state?.['content']) || (status === 'error' ? errorOf(state?.['error']) ?? '' : '');
  const part: OpenCodePart = { kind: 'tool', name: str(raw, 'tool') ?? str(raw, 'name') ?? 'unknown', callId: str(raw, 'callID') ?? str(raw, 'id') ?? '', input: state?.['input'] ?? {}, output };
  if (status) part.status = status;
  if (ts !== undefined) part.ts = ts;
  return part;
}

function partOf(raw: Record<string, unknown> | undefined, fallbackTs: number | undefined): OpenCodePart | undefined {
  if (!raw) return undefined;
  const type = str(raw, 'type');
  const ts = num(rec(raw, 'time'), 'created') ?? num(rec(raw, 'time'), 'start') ?? fallbackTs;
  if (type === 'tool') return toolPart(raw, ts);
  if (type === 'text' || type === 'reasoning') {
    if (raw['synthetic'] === true || raw['ignored'] === true) return undefined;
    return { kind: type, text: str(raw, 'text') ?? '', ...(ts !== undefined ? { ts } : {}) };
  }
  return undefined;
}

function messageOf(id: string, created: number, data: Record<string, unknown> | undefined, type: string | undefined): OpenCodeMessage | undefined {
  if (!data) return undefined;
  const role = str(data, 'role') ?? type;
  const time = num(rec(data, 'time'), 'created') ?? created;
  if (role === 'user') {
    const text = str(data, 'text') ?? textOf(data['content']);
    return { id, role, created: time, text, parts: [] };
  }
  if (role === 'system' || role === 'synthetic') return { id, role: 'system', created: time, text: str(data, 'text') ?? '', parts: [] };
  if (role !== 'assistant') return undefined;
  const modelRecord = rec(data, 'model');
  const model = str(modelRecord, 'id') ?? str(modelRecord, 'modelID') ?? str(data, 'modelID');
  const message: OpenCodeMessage = { id, role, created: time, parts: [] };
  if (model) message.model = model;
  const variant = str(modelRecord, 'variant');
  if (variant) message.variant = variant;
  const tokens = tokensOf(rec(data, 'tokens'));
  if (tokens) message.tokens = tokens;
  const finish = str(data, 'finish');
  if (finish) message.finish = finish;
  const error = errorOf(data['error']);
  if (error) message.error = error;
  const cwd = str(rec(data, 'path'), 'cwd');
  if (cwd) message.cwd = cwd;
  for (const item of list(data, 'content')) {
    const part = partOf(asRecord(item), time);
    if (part) message.parts.push(part);
  }
  return message;
}

export function loadOpenCodeSession(dbPath: string, sessionId: string): OpenCodeSession | undefined {
  const db = open(dbPath);
  try {
    let found: OpenCodeSession | undefined;
    for (const layout of layoutsIn(db)) {
      const row = db.prepare(`SELECT id, parent_id, directory, title, version, time_created, time_updated FROM ${layout.session} WHERE id = ?`).get(sessionId) as Record<string, unknown> | undefined;
      if (!row) continue;
      const messages: OpenCodeMessage[] = [];
      const order = layout.inline ? 'seq' : 'time_created, id';
      const typed = layout.inline ? ', type' : '';
      const rows = db.prepare(`SELECT id, time_created, data${typed} FROM ${layout.message} WHERE session_id = ? ORDER BY ${order}`).all(sessionId) as Record<string, unknown>[];
      const parts = new Map<string, OpenCodePart[]>();
      if (layout.part) {
        for (const partRow of db.prepare(`SELECT message_id, time_created, data FROM ${layout.part} WHERE session_id = ? ORDER BY time_created, id`).all(sessionId) as Record<string, unknown>[]) {
          const part = partOf(asRecord(parseJson(String(partRow['data']))), count(partRow['time_created']));
          if (!part) continue;
          const key = String(partRow['message_id']);
          parts.set(key, [...(parts.get(key) ?? []), part]);
        }
      }
      for (const messageRow of rows) {
        const id = String(messageRow['id']);
        const message = messageOf(id, count(messageRow['time_created']), asRecord(parseJson(String(messageRow['data']))), typeof messageRow['type'] === 'string' ? messageRow['type'] : undefined);
        if (!message) continue;
        if (message.role === 'assistant' && message.parts.length === 0) message.parts = parts.get(id) ?? [];
        if (message.role === 'user' && !message.text) message.text = (parts.get(id) ?? []).filter((part) => part.kind === 'text').map((part) => part.text ?? '').join('\n');
        messages.push(message);
      }
      const size = messages.length;
      found = {
        id: sessionId, created: count(row['time_created']), updated: count(row['time_updated']), size, messages,
        ...(nonEmpty(row['parent_id']) ? { parentId: String(row['parent_id']) } : {}),
        ...(nonEmpty(row['directory']) ? { directory: String(row['directory']) } : {}),
        ...(nonEmpty(row['title']) ? { title: String(row['title']) } : {}),
        ...(nonEmpty(row['version']) ? { version: String(row['version']) } : {}),
      };
    }
    return found;
  } finally {
    db.close();
  }
}

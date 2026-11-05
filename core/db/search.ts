/**
 * Search (SPEC §6). Two indexes:
 *  - `sessions_fts` (trigram) for case-insensitive substring matching on titles;
 *  - `messages_fts` (unicode61) for content, ranked with bm25 and highlighted with snippet().
 *
 * Snippet markers are emitted as control characters, the whole snippet is then HTML-escaped, and
 * the markers become `<mark>` — so matched text is highlighted without ever trusting transcript
 * content as HTML.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MessageKind, SearchHit, SearchKind, SearchQuery } from '../types.js';
import { escapeHtml } from '../pricing/format.js';
import { num, optStr, str, type Row } from './rows.js';

const MARK_START = '\u0001';
const MARK_END = '\u0002';
/** The trigram tokenizer cannot match anything shorter than three characters. */
export const MIN_TRIGRAM_CHARS = 3;

/** Wraps the user's text as a single FTS5 phrase so operators in the query are inert. */
export function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export function decorateSnippet(raw: string): string {
  return escapeHtml(raw)
    .replaceAll(MARK_START, '<mark>')
    .replaceAll(MARK_END, '</mark>');
}

const KIND_CLAUSES: Record<SearchKind, string> = {
  prompt: "m.kind = 'prompt'",
  assistant: "m.kind = 'assistant'",
  thinking: "m.kind = 'assistant'",
  tool_use: "m.role = 'assistant' AND m.toolNames IS NOT NULL",
  tool_result: "m.kind = 'tool_result'",
};

export interface ContentHitRow {
  sessionId: string;
  hit: SearchHit;
}

/** The MATCH plus every filter, shared by the ranked scan and the exact hit count. */
function contentWhere(
  q: SearchQuery,
  hideScratch: boolean,
): { sql: string; params: (string | number)[] } {
  const clauses: string[] = ['messages_fts MATCH ?'];
  const params: (string | number)[] = [ftsPhrase(q.q)];

  const kinds = q.kinds && q.kinds.length > 0 ? [...new Set(q.kinds)] : [];
  if (kinds.length > 0) {
    clauses.push(`(${kinds.map((kind) => `(${KIND_CLAUSES[kind]})`).join(' OR ')})`);
  }
  if (q.model) {
    clauses.push('m.model = ?');
    params.push(q.model);
  }
  if (q.tool) {
    clauses.push("(' ' || COALESCE(m.toolNames, '') || ' ') LIKE ?");
    params.push(`% ${q.tool} %`);
  }
  if (q.provider) {
    clauses.push('s.provider = ?');
    params.push(q.provider);
  }
  if (q.project) {
    clauses.push('(s.projectId = ? OR p.path = ?)');
    params.push(q.project, q.project);
  } else if (hideScratch) {
    clauses.push('COALESCE(p.isScratch, 0) = 0');
  }
  if (q.from) {
    clauses.push('m.dateLocal >= ?');
    params.push(q.from);
  }
  if (q.to) {
    clauses.push('m.dateLocal <= ?');
    params.push(q.to);
  }
  return { sql: clauses.join(' AND '), params };
}

const CONTENT_FROM = `FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN sessions s ON s.id = m.sessionId
       LEFT JOIN projects p ON p.id = s.projectId`;

/**
 * Hits per matching session, over the *whole* match — no window. Ranking is what makes the scan
 * in {@link searchContent} expensive, so counting without `bm25()` costs a fraction of it
 * (~10 ms typical, ~85 ms for a stop word over 12.7k hits) and lets `SearchResponse.totalSessions`
 * and `SearchSessionGroup.hitCount` be exact instead of window-bounded.
 */
export function countContentHits(
  db: DatabaseSync,
  q: SearchQuery,
  hideScratch: boolean,
): Map<string, number> {
  const where = contentWhere(q, hideScratch);
  const rows = db
    .prepare(
      `SELECT m.sessionId AS sessionId, COUNT(*) AS n
       ${CONTENT_FROM}
       WHERE ${where.sql}
       GROUP BY m.sessionId`,
    )
    .all(...where.params) as Row[];
  return new Map(rows.map((row) => [str(row, 'sessionId'), num(row, 'n')]));
}

/** Ranked content hits, best first. `limit` bounds the raw hit window, not the group count. */
export function searchContent(
  db: DatabaseSync,
  q: SearchQuery,
  hideScratch: boolean,
  limit: number,
): ContentHitRow[] {
  const where = contentWhere(q, hideScratch);
  const rows = db
    .prepare(
      `SELECT m.sessionId AS sessionId, m.agentId AS agentId, m.seq AS seq, m.kind AS kind, m.ts AS ts,
        snippet(messages_fts, 0, char(1), char(2), '…', 14) AS snip,
        bm25(messages_fts) AS score
       ${CONTENT_FROM}
       WHERE ${where.sql}
       ORDER BY score, m.sessionId, m.seq
       LIMIT ?`,
    )
    .all(...where.params, limit) as Row[];

  return rows.map((row) => {
    const agentId = str(row, 'agentId');
    const hit: SearchHit = {
      seq: num(row, 'seq'),
      agentId: agentId === '' ? null : agentId,
      kind: str(row, 'kind') as MessageKind,
      snippet: decorateSnippet(str(row, 'snip')),
      score: -num(row, 'score'),
    };
    const ts = optStr(row, 'ts');
    if (ts) hit.ts = ts;
    return { sessionId: str(row, 'sessionId'), hit };
  });
}

/** Session ids whose title, first prompt or project path contains the query. */
export function searchTitles(db: DatabaseSync, query: string, limit: number): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length < MIN_TRIGRAM_CHARS) {
    const rows = db
      .prepare(
        `SELECT id FROM sessions
         WHERE LOWER(title) LIKE ? OR LOWER(firstPrompt) LIKE ?
         ORDER BY startedAt DESC LIMIT ?`,
      )
      .all(`%${trimmed.toLowerCase()}%`, `%${trimmed.toLowerCase()}%`, limit) as Row[];
    return rows.map((row) => str(row, 'id'));
  }
  const rows = db
    .prepare(
      `SELECT sessionId, rank FROM sessions_fts WHERE sessions_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(ftsPhrase(trimmed), limit) as Row[];
  return rows.map((row) => str(row, 'sessionId'));
}

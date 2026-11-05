/**
 * Date-range resolution and the shared session WHERE clause.
 * Every value is bound as a parameter; only table and column names are literals in this file.
 */
import type { RangeQuery, SessionsQuery, UserSettings } from '../types.js';
import { localDateKey } from '../cost/plan.js';

export interface DateRange {
  from: string;
  to: string;
}

export const DEFAULT_RANGE_DAYS = 30;

/** Local, inclusive `YYYY-MM-DD` bounds. Missing bounds default to the last 30 days. */
export function resolveRange(q: RangeQuery, now: Date): DateRange {
  const to = q.to ?? localDateKey(now);
  let from = q.from;
  if (!from) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DEFAULT_RANGE_DAYS - 1));
    from = localDateKey(start);
  }
  return from <= to ? { from, to } : { from: to, to: from };
}

export interface SqlScope {
  /** joins + WHERE, ready to append after `FROM sessions s` */
  sql: string;
  params: (string | number)[];
}

export interface SessionScopeOptions {
  /** filter sessions by their start date when set */
  range?: DateRange;
  /** filter sessions to those with at least one request inside the range (analytics semantics) */
  activeRange?: DateRange;
  /** restrict to these session ids (already a bounded list) */
  sessionIds?: readonly string[];
  /** skip the hide-scratch-projects filter (detail pages must open any session by id) */
  includeHidden?: boolean;
}

/**
 * Builds the session scope used by the sessions list, exports and analytics.
 * Scratch projects are hidden when the setting asks for it, unless the query targets that project
 * explicitly — otherwise a user could never open a session they linked to.
 */
export function sessionScope(
  q: SessionsQuery,
  settings: UserSettings,
  options: SessionScopeOptions = {},
): SqlScope {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (options.range) {
    clauses.push('s.startedDate >= ? AND s.startedDate <= ?');
    params.push(options.range.from, options.range.to);
  }
  if (options.activeRange) {
    clauses.push(
      'EXISTS (SELECT 1 FROM requests r WHERE r.sessionId = s.id AND r.dateLocal >= ? AND r.dateLocal <= ?)',
    );
    params.push(options.activeRange.from, options.activeRange.to);
  }
  if (q.provider) {
    clauses.push('s.provider = ?');
    params.push(q.provider);
  }
  if (q.project) {
    clauses.push('(s.projectId = ? OR p.path = ?)');
    params.push(q.project, q.project);
  } else if (settings.hideScratchProjects && !options.includeHidden) {
    clauses.push('COALESCE(p.isScratch, 0) = 0');
  }
  if (q.q) {
    clauses.push('(LOWER(s.title) LIKE ? OR LOWER(s.firstPrompt) LIKE ?)');
    const like = `%${q.q.toLowerCase()}%`;
    params.push(like, like);
  }
  if (q.model) {
    clauses.push('s.modelsJson LIKE ?');
    params.push(`%"${q.model}"%`);
  }
  if (q.entrypoint) {
    clauses.push('s.entrypoint = ?');
    params.push(q.entrypoint);
  }
  if (q.hasAgents) {
    clauses.push('s.agentCount > 0');
  }
  if (options.sessionIds) {
    if (options.sessionIds.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push(`s.id IN (${options.sessionIds.map(() => '?').join(',')})`);
      params.push(...options.sessionIds);
    }
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return { sql: ` LEFT JOIN projects p ON p.id = s.projectId${where}`, params };
}

/** Opaque keyset cursor: the id of the last row of the previous page. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const id = Buffer.from(cursor, 'base64url').toString('utf8');
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

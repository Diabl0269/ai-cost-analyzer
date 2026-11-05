/**
 * Transcript paging. Message text is not stored in the index; lines are re-read from the original
 * JSONL by `(byteOffset, byteLength)` and turned into display blocks here.
 *
 * Assistant messages are split across several JSONL lines that share `message.id` (SPEC §3.3), so
 * their blocks are merged back into the first line of the message.
 */
import { normalizeCodexLine } from '../codex/normalize.js';
import type { DatabaseSync } from 'node:sqlite';
import type {
  MessageKind,
  MessageRole,
  RequestCost,
  TranscriptBlock,
  TranscriptMessage,
  TranscriptPage,
} from '../types.js';
import { parseLine, readLinesAt, type LineRange } from './lines.js';
import { bool, num, optStr, str, type Row } from './rows.js';
import { MAIN_AGENT } from './write-session.js';

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = asRecord(part);
        return record && typeof record['text'] === 'string' ? record['text'] : '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return '';
}

function contentBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  const out: TranscriptBlock[] = [];
  for (const raw of asArray(content)) {
    const block = asRecord(raw);
    if (!block) continue;
    const type = typeof block['type'] === 'string' ? block['type'] : '';
    switch (type) {
      case 'text':
        out.push({ type: 'text', text: textOf(block['text']) });
        break;
      case 'thinking':
        out.push({ type: 'thinking', text: textOf(block['thinking'] ?? block['text']) });
        break;
      case 'tool_use':
        out.push({
          type: 'tool_use',
          id: typeof block['id'] === 'string' ? block['id'] : '',
          name: typeof block['name'] === 'string' ? block['name'] : 'unknown',
          input: block['input'],
        });
        break;
      case 'tool_result': {
        const inner = asArray(block['content']);
        const images = inner.filter((part) => asRecord(part)?.['type'] === 'image').length;
        out.push({
          type: 'tool_result',
          toolUseId: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '',
          text: textOf(block['content']),
          images,
          isError: block['is_error'] === true,
        });
        break;
      }
      case 'image':
        out.push({ type: 'image', count: 1 });
        break;
      default:
        out.push({ type: 'other', label: type || 'block' });
    }
  }
  return out;
}

/** Builds the display blocks for one raw JSONL line. */
export function blocksForLine(line: Record<string, unknown> | null): TranscriptBlock[] {
  if (!line) return [{ type: 'other', label: 'unavailable' }];
  if (line['type'] === 'response_item' || line['type'] === 'event_msg' || line['type'] === 'compacted') {
    const normalized = normalizeCodexLine(line);
    if (normalized) return blocksForLine(normalized);
  }
  const type = typeof line['type'] === 'string' ? line['type'] : '';
  if (type === 'user' || type === 'assistant') {
    const message = asRecord(line['message']);
    return contentBlocks(message ? message['content'] : undefined);
  }
  if (type === 'attachment') {
    const attachment = asRecord(line['attachment']);
    const rendered = asArray(line['rendered']);
    const text = rendered
      .map((part) => textOf(asRecord(part)?.['content']))
      .filter((s) => s.length > 0)
      .join('\n');
    if (text.length > 0) return [{ type: 'text', text }];
    const label = attachment && typeof attachment['type'] === 'string' ? attachment['type'] : 'attachment';
    return [{ type: 'other', label }];
  }
  if (type === 'system') {
    const text = textOf(line['content']);
    if (text.length > 0) return [{ type: 'text', text }];
    const subtype = typeof line['subtype'] === 'string' ? line['subtype'] : 'system';
    return [{ type: 'other', label: subtype }];
  }
  return [{ type: 'other', label: type || 'line' }];
}

interface TranscriptSource {
  filePath: string;
  totalLines: number;
}

function transcriptSource(db: DatabaseSync, sessionId: string, agentId: string): TranscriptSource | null {
  if (agentId === MAIN_AGENT) {
    const row = db.prepare('SELECT filePath, lineCount FROM sessions WHERE id = ?').get(sessionId) as
      | Row
      | undefined;
    return row ? { filePath: str(row, 'filePath'), totalLines: num(row, 'lineCount') } : null;
  }
  const row = db.prepare('SELECT filePath FROM agents WHERE sessionId = ? AND agentId = ?').get(
    sessionId,
    agentId,
  ) as Row | undefined;
  if (!row) return null;
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE sessionId = ? AND agentId = ?')
    .get(sessionId, agentId) as Row | undefined;
  return { filePath: str(row, 'filePath'), totalLines: count ? num(count, 'n') : 0 };
}

export async function getTranscriptPage(
  db: DatabaseSync,
  sessionId: string,
  agentId: string | null,
  fromSeq: number,
  limit: number,
  requestCosts: ReadonlyMap<number, RequestCost>,
): Promise<TranscriptPage | null> {
  const agent = agentId ?? MAIN_AGENT;
  const source = transcriptSource(db, sessionId, agent);
  if (!source) return null;
  const capped = Math.max(1, Math.min(limit, 500));
  const rows = db
    .prepare(
      `SELECT seq, turnIndex, uuid, ts, role, kind, subtype, messageId, requestSeq, byteOffset, byteLength, isMeta
       FROM messages WHERE sessionId = ? AND agentId = ? AND seq >= ? ORDER BY seq LIMIT ?`,
    )
    .all(sessionId, agent, fromSeq, capped + 1) as Row[];
  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;

  const ranges: LineRange[] = page.map((row) => ({
    byteOffset: num(row, 'byteOffset'),
    byteLength: num(row, 'byteLength'),
  }));
  const lines = await readLinesAt(source.filePath, ranges);

  const messages: TranscriptMessage[] = [];
  const byMessageId = new Map<string, TranscriptMessage>();
  page.forEach((row, i) => {
    const blocks = blocksForLine(parseLine(lines[i] ?? null));
    const messageId = optStr(row, 'messageId');
    if (messageId) {
      const existing = byMessageId.get(messageId);
      if (existing) {
        existing.blocks.push(...blocks);
        return;
      }
    }
    const requestSeq = row['requestSeq'] === null ? undefined : num(row, 'requestSeq');
    const message: TranscriptMessage = {
      seq: num(row, 'seq'),
      turnIndex: num(row, 'turnIndex'),
      uuid: str(row, 'uuid'),
      role: str(row, 'role') as MessageRole,
      kind: str(row, 'kind') as MessageKind,
      blocks,
      isMeta: bool(row, 'isMeta'),
    };
    const ts = optStr(row, 'ts');
    if (ts) message.ts = ts;
    const subtype = optStr(row, 'subtype');
    if (subtype) message.subtype = subtype;
    if (messageId) message.messageId = messageId;
    if (requestSeq !== undefined) {
      message.requestSeq = requestSeq;
      const cost = requestCosts.get(requestSeq);
      if (cost && cost.seq === message.seq) message.request = cost;
    }
    messages.push(message);
    if (messageId) byMessageId.set(messageId, message);
  });

  const lastRow = page[page.length - 1];
  return {
    sessionId,
    agentId: agentId ?? null,
    messages,
    nextFromSeq: hasMore && lastRow ? num(lastRow, 'seq') + 1 : null,
    totalLines: source.totalLines,
  };
}

/** OpenCode sessions → the shared transcript vocabulary. A line's virtual sequence number is its array index. */
import { Builder } from '../parse/transcript.js';
import type { DiscoveredFile, ParsedTranscript } from '../types.js';
import { isOpenCodePath, loadOpenCodeSession, splitOpenCodePath, type OpenCodeMessage, type OpenCodeSession, type OpenCodeTokens } from './db.js';

type Raw = Record<string, unknown>;

/** OpenCode reports input without cache reads/writes and reasoning separately from output. */
export function openCodeUsage(tokens: OpenCodeTokens): Raw {
  return {
    input_tokens: tokens.input, output_tokens: tokens.output + tokens.reasoning,
    cache_read_input_tokens: tokens.cacheRead, cache_creation_input_tokens: tokens.cacheWrite,
    output_tokens_details: { thinking_tokens: tokens.reasoning },
  };
}

function iso(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

function assistantLines(message: OpenCodeMessage, billed: Set<string>): Raw[] {
  const timestamp = iso(message.created);
  const model = message.model ?? '';
  const results: Raw[] = [];
  const lines: Raw[] = [];
  const envelope = (ts: number | undefined, content: Raw[]): Raw => ({
    type: 'assistant', timestamp: iso(ts) ?? timestamp, ...(message.variant ? { effort: message.variant } : {}),
    message: { id: message.id, model, content },
  });
  for (const part of message.parts) {
    if (part.kind === 'tool') {
      const id = part.callId ?? '';
      lines.push(envelope(part.ts, [{ type: 'tool_use', id, name: part.name ?? 'unknown', input: part.input ?? {} }]));
      if (part.status !== 'pending' && part.status !== 'running') {
        results.push({ type: 'user', timestamp: iso(part.ts) ?? timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, content: part.output ?? '', is_error: part.status === 'error' }] } });
      }
    } else if (part.kind === 'reasoning') {
      lines.push(envelope(part.ts, [{ type: 'thinking', thinking: part.text ?? '' }]));
    } else if (part.text) {
      lines.push(envelope(part.ts, [{ type: 'text', text: part.text }]));
    }
  }
  if (lines.length === 0 && (message.tokens || message.model)) lines.push(envelope(message.created, []));
  const last = lines[lines.length - 1];
  if (last && message.tokens) {
    (last['message'] as Raw)['usage'] = openCodeUsage(message.tokens);
    billed.add(message.id);
  }
  return [...lines, ...results];
}

export function openCodeLines(session: OpenCodeSession): { lines: Raw[]; billed: Set<string>; unbilledOutput: boolean } {
  const lines: Raw[] = [];
  const billed = new Set<string>();
  let unbilledOutput = false;
  for (const message of session.messages) {
    if (message.role === 'assistant') {
      if (!message.tokens && message.parts.length > 0) unbilledOutput = true;
      lines.push(...assistantLines(message, billed));
    } else if (message.text !== undefined) {
      lines.push({ type: 'user', uuid: message.id, timestamp: iso(message.created), isMeta: message.role === 'system', message: { content: message.text } });
    }
  }
  return { lines, billed, unbilledOutput };
}

/** Reconstructs the transcript lines of one OpenCode session for the viewer. */
export async function readOpenCodeSessionLines(filePath: string): Promise<Raw[]> {
  const target = splitOpenCodePath(filePath);
  const session = target ? loadOpenCodeSession(target.dbPath, target.sessionId) : undefined;
  return session ? openCodeLines(session).lines : [];
}

export { isOpenCodePath };

export async function parseOpenCodeTranscript(file: DiscoveredFile, agentId: string | null = null): Promise<ParsedTranscript> {
  const target = splitOpenCodePath(file.path);
  const session = target ? loadOpenCodeSession(target.dbPath, target.sessionId) : undefined;
  if (!session) throw new Error('OpenCode session is unavailable');
  const { lines, billed, unbilledOutput } = openCodeLines(session);
  const builder = new Builder(file, agentId, agentId === null);
  builder.meta.entrypoint = 'opencode';
  if (session.directory) builder.meta.cwd = session.directory;
  if (session.version) builder.meta.version = session.version;
  // OpenCode's placeholder titles are timestamps, not summaries.
  if (session.title && !/^(?:New|Child) session - /i.test(session.title)) builder.facts.aiTitle = session.title;
  builder.meta.lineCount = lines.length;
  for (const [seq, line] of lines.entries()) builder.take(line, seq, { byteOffset: 0, byteLength: 0 });
  const transcript = builder.finish();
  transcript.requests = transcript.requests.filter((request) => billed.has(request.messageId));
  if (unbilledOutput) transcript.meta.usageIncomplete = true;
  const billedSeqs = new Set(transcript.requests.map((request) => request.seq));
  for (const message of transcript.messages) {
    if (message.requestSeq !== undefined && !billedSeqs.has(message.requestSeq)) delete message.requestSeq;
  }
  for (const call of transcript.toolCalls) {
    if (!billedSeqs.has(call.requestSeq)) call.requestSeq = -1;
  }
  return transcript;
}

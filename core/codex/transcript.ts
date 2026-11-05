import { readJsonlLines } from '../jsonl.js';
import { Builder } from '../parse/transcript.js';
import { asRecord, count, parseJson, rec, str } from '../parse/raw.js';
import type { ByteRange, DiscoveredFile, ParsedTranscript } from '../types.js';
import { normalizeCodexLine } from './normalize.js';

type Raw = Record<string, unknown>;
const COUNTERS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'cache_write_input_tokens'] as const;

/** Usage counters in Codex include cached input and reasoning output as subsets. */
export function codexUsage(raw: Raw): Raw {
  const input = Math.max(0, count(raw['input_tokens']));
  const cached = Math.min(input, Math.max(0, count(raw['cached_input_tokens'])));
  const output = Math.max(0, count(raw['output_tokens']));
  const write = Math.min(input - cached, Math.max(0, count(raw['cache_write_input_tokens'])));
  return {
    input_tokens: input - cached - write, output_tokens: output,
    cache_read_input_tokens: cached, cache_creation_input_tokens: write,
    output_tokens_details: { thinking_tokens: Math.min(output, Math.max(0, count(raw['reasoning_output_tokens']))) },
  };
}

export async function parseCodexTranscript(file: DiscoveredFile, agentId: string | null = null): Promise<ParsedTranscript> {
  const builder = new Builder(file, agentId, agentId === null);
  const titles: { customTitle?: string; aiTitle?: string } = {};
  let model = '';
  let effort: string | undefined;
  let requestedTier: string | undefined;
  let requestedSpeed: string | undefined;
  let cumulative: Raw | undefined;
  let group = 0;
  const billedGroups = new Set<string>();
  const responseUserMessages = new Map<string, number>();
  const responseIds = new Set<string>();
  const pending: { object: Raw; seq: number; range: ByteRange }[] = [];
  // Older rollouts duplicate human prompts as both response items and event messages. Inspect
  // shapes only first, then stream the content once into the builder without retaining the file.
  for await (const line of readJsonlLines(file.path)) {
    const raw = asRecord(parseJson(line.text));
    if (raw?.['type'] !== 'response_item' || rec(raw, 'payload')?.['role'] !== 'user') continue;
    const content = rec(normalizeCodexLine(raw, { promptOnly: true }), 'message')?.['content'];
    const key = Array.isArray(content) ? content.map((part) => str(asRecord(part), 'text') ?? '').filter(Boolean).join('\n') : typeof content === 'string' ? content : '';
    responseUserMessages.set(key, (responseUserMessages.get(key) ?? 0) + 1);
  }
  function flush(usage?: Raw, billing?: { object: Raw; seq: number; range: ByteRange }): void {
    if (usage && pending.length === 0 && billing) pending.push(billing);
    const last = pending[pending.length - 1];
    if (usage) billedGroups.add(`codex-request-${group}`);
    for (const item of pending) {
      const message = rec(item.object, 'message') ?? {};
      item.object['message'] = { ...message, id: `codex-request-${group}`, model, ...(item === last && usage ? { usage } : {}) };
      if (effort) item.object['effort'] = effort;
      builder.take(item.object, item.seq, item.range);
    }
    if (pending.length > 0) group += 1;
    pending.length = 0;
  }
  for await (const line of readJsonlLines(file.path)) {
    builder.meta.lineCount += 1;
    if (!line.text.trim()) continue;
    const raw = asRecord(parseJson(line.text));
    if (!raw) { builder.meta.parseErrors += 1; continue; }
    const payload = rec(raw, 'payload');
    if (!payload) continue;
    const type = str(raw, 'type');
    const ts = str(raw, 'timestamp');
    if (ts) {
      if (!builder.meta.firstTs || ts < builder.meta.firstTs) builder.meta.firstTs = ts;
      if (!builder.meta.lastTs || ts > builder.meta.lastTs) builder.meta.lastTs = ts;
    }
    if (type === 'session_meta') {
      const cwd = str(payload, 'cwd');
      const branch = str(rec(payload, 'git'), 'branch');
      const version = str(payload, 'cli_version');
      if (cwd) builder.meta.cwd = cwd;
      if (branch) builder.meta.gitBranch = branch;
      if (version) builder.meta.version = version;
      builder.meta.entrypoint = str(payload, 'originator') ?? 'codex';
      const customTitle = str(payload, 'custom_title') ?? str(payload, 'title') ?? str(payload, 'thread_name');
      const aiTitle = str(payload, 'ai_title');
      if (customTitle?.trim()) titles.customTitle = customTitle;
      if (aiTitle?.trim()) titles.aiTitle = aiTitle;
      continue;
    }
    if (type === 'turn_context') {
      // A resume or model switch starts a new context; never reprice earlier requests.
      if (pending.length) flush();
      model = str(payload, 'model') ?? model;
      effort = str(payload, 'effort');
      requestedTier = str(payload, 'service_tier');
      requestedSpeed = str(payload, 'speed');
      continue;
    }
    const range = { byteOffset: line.byteOffset, byteLength: line.byteLength };
    const isRecord = type === 'token_usage_record';
    const isCounter = type === 'event_msg' && payload['type'] === 'token_count';
    if (isRecord || isCounter) {
      const info = rec(payload, 'info');
      const total = isRecord ? rec(payload, 'thread_token_usage') : rec(info, 'total_token_usage');
      const last = isRecord ? rec(payload, 'usage') : rec(info, 'last_token_usage');
      if (!total && !last) continue;
      // Legacy resumes can replay the previous process's last usage before any current
      // assistant output. Keep the cumulative baseline, but do not invent a new request.
      // Explicit modern per-response records remain billable without visible output.
      if (isCounter && !cumulative && pending.length === 0 && !builder.messages.some((message) => message.role === 'assistant')) {
        if (total) cumulative = total;
        continue;
      }
      const responseId = isRecord ? str(payload, 'response_id') : undefined;
      if (responseId && responseIds.has(responseId)) continue;
      if (responseId) responseIds.add(responseId);
      let delta: Raw | undefined;
      if (total && cumulative) {
        const equal = COUNTERS.every((key) => count(total[key]) === count(cumulative?.[key]));
        if (equal) continue;
        const reset = COUNTERS.some((key) => count(total[key]) < count(cumulative?.[key]));
        delta = reset ? last ?? total : Object.fromEntries(COUNTERS.map((key) => [key, count(total[key]) - count(cumulative?.[key])]));
      } else delta = last ?? total;
      if (total) cumulative = total;
      if (!delta || !COUNTERS.some((key) => count(delta?.[key]) > 0)) continue;
      // A record's explicit per-response usage is authoritative. Its cumulative count is used
      // solely to suppress the mirrored legacy token_count event.
      if (isRecord && last) delta = last;
      const reportedTier = str(last, 'service_tier') ?? str(payload, 'service_tier');
      const reportedSpeed = str(last, 'speed') ?? str(payload, 'speed');
      const reportedMode = reportedTier !== undefined || reportedSpeed !== undefined;
      const tier = reportedMode ? reportedTier : requestedTier;
      const speed = reportedMode ? reportedSpeed : requestedSpeed;
      const fast = tier === 'priority' || tier === 'fast' || speed === 'fast';
      const normalizedUsage = { ...codexUsage(delta), speed: fast ? 'fast' : 'standard', service_tier: fast ? 'priority' : 'standard' };
      flush(normalizedUsage, { object: { type: 'assistant', timestamp: ts, message: { content: [] } }, seq: line.seq, range });
      continue;
    }
    const normalized = normalizeCodexLine(raw, { promptOnly: true });
    if (!normalized) continue;
    if (type === 'event_msg' && payload['type'] === 'user_message') {
      const key = str(rec(normalized, 'message'), 'content') ?? '';
      const mirrors = responseUserMessages.get(key) ?? 0;
      if (mirrors > 0) { responseUserMessages.set(key, mirrors - 1); continue; }
    }
    normalized['uuid'] = `${file.sessionId}-${line.seq}`;
    if (normalized['type'] === 'assistant') {
      pending.push({ object: normalized, seq: line.seq, range });
    } else {
      const content = rec(normalized, 'message')?.['content'];
      const isToolResult = Array.isArray(content) && asRecord(content[0])?.['type'] === 'tool_result';
      if (!isToolResult && normalized['isMeta'] !== true) flush();
      builder.take(normalized, line.seq, range);
      const harnessChars = count(normalized['codexHarnessChars']);
      if (harnessChars > 0) builder.injections.push({
        seq: line.seq, turnIndex: builder.messages[builder.messages.length - 1]?.turnIndex ?? 0,
        ...(ts ? { ts } : {}), kind: 'other', name: 'codex_context', chars: harnessChars, charsSource: 'content',
      });
      if (type === 'compacted') builder.compactions.push({ seq: line.seq, turnIndex: builder.messages[builder.messages.length - 1]?.turnIndex ?? 0, ...(ts ? { ts } : {}) });
    }
  }
  flush();
  const transcript = builder.finish();
  if (transcript.facts) Object.assign(transcript.facts, titles);
  // Text without usage remains readable/searchable but cannot establish a billed API call.
  transcript.requests = transcript.requests.filter((request) => billedGroups.has(request.messageId));
  const billedTurns = new Set(transcript.requests.map((request) => request.turnIndex));
  if (transcript.messages.some((message) => message.role === 'assistant' && !billedTurns.has(message.turnIndex))) {
    transcript.meta.usageIncomplete = true;
  }
  const billedSeqs = new Set(transcript.requests.map((request) => request.seq));
  for (const message of transcript.messages) {
    if (message.requestSeq !== undefined && !billedSeqs.has(message.requestSeq)) delete message.requestSeq;
  }
  for (const call of transcript.toolCalls) {
    if (!billedSeqs.has(call.requestSeq)) call.requestSeq = -1;
  }
  transcript.messages.sort((a, b) => a.seq - b.seq);
  return transcript;
}

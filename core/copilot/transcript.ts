/**
 * SDK schema: github/copilot-sdk nodejs/src/generated/session-events.ts.
 * Durable modelMetrics are session-cumulative (including resumes), not per-call telemetry.
 * Residual aggregate rows preserve tokens without inventing a request count or context size.
 * Copilot premium-request multipliers / AI credits are deliberately never interpreted as USD.
 */
import { readJsonlLines } from '../jsonl.js';
import { Builder } from '../parse/transcript.js';
import { asRecord, count, parseJson, rec, str } from '../parse/raw.js';
import type { DiscoveredFile, ParsedTranscript } from '../types.js';
import { normalizeCopilotLine } from './normalize.js';

type Raw = Record<string, unknown>;
const KEYS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'] as const;
type Counters = Record<typeof KEYS[number], number>;
function counters(raw: Raw | undefined): Counters {
  return Object.fromEntries(KEYS.map((key) => [key, Math.max(0, count(raw?.[key]))])) as Counters;
}
function complete(raw: Raw | undefined): boolean {
  return ['inputTokens', 'outputTokens'].every((key) => typeof raw?.[key] === 'number' && Number.isFinite(raw[key]) && Number(raw[key]) >= 0);
}
/** Copilot input includes cached input; reasoning is a subset of output. */
export function copilotUsage(raw: Raw): Raw {
  const u = counters(raw);
  const read = Math.min(u.inputTokens, u.cacheReadTokens);
  const write = Math.min(u.inputTokens - read, u.cacheWriteTokens);
  return {
    input_tokens: u.inputTokens - read - write, output_tokens: u.outputTokens,
    cache_read_input_tokens: read, cache_creation_input_tokens: write,
    output_tokens_details: { thinking_tokens: Math.min(u.outputTokens, u.reasoningTokens) },
  };
}

export async function parseCopilotTranscript(file: DiscoveredFile, agentId: string | null = null): Promise<ParsedTranscript> {
  const builder = new Builder(file, agentId, agentId === null);
  const seen = new Set<string>();
  const calls = new Set<string>();
  const accounted = new Map<string, Counters>();
  const billed = new Set<string>();
  const aggregates = new Set<string>();
  const hidden = new Set<number>();
  let model = '';
  let effort: string | undefined;
  let coveredThrough = -1;
  const assistantCoverage: { seq: number; callId?: string }[] = [];
  const meteredCalls = new Set<string>();
  let partial = false;
  let title: string | undefined;

  for await (const line of readJsonlLines(file.path)) {
    builder.meta.lineCount += 1;
    if (!line.text.trim()) continue;
    const raw = asRecord(parseJson(line.text));
    if (!raw) { builder.meta.parseErrors += 1; continue; }
    const data = rec(raw, 'data');
    if (!data) continue;
    const eventId = str(raw, 'id');
    if (eventId && seen.has(eventId)) continue;
    if (eventId) seen.add(eventId);
    const type = str(raw, 'type');
    const ts = str(raw, 'timestamp');
    if (ts) {
      if (!builder.meta.firstTs || ts < builder.meta.firstTs) builder.meta.firstTs = ts;
      if (!builder.meta.lastTs || ts > builder.meta.lastTs) builder.meta.lastTs = ts;
    }
    const range = { byteOffset: line.byteOffset, byteLength: line.byteLength };
    if (type === 'session.start' || type === 'session.resume' || type === 'session.context_changed') {
      const context = type === 'session.context_changed' ? data : rec(data, 'context');
      // Keep initial cwd for stable project grouping across a session changing directory.
      builder.meta.cwd ??= str(context, 'cwd') ?? str(data, 'cwd');
      const branch = str(context, 'branch');
      if (branch) builder.meta.gitBranch = branch;
      const version = str(data, 'copilotVersion');
      if (version) builder.meta.version = version;
      builder.meta.entrypoint ??= str(data, 'producer') ?? 'copilot';
      model = str(data, 'selectedModel') ?? model;
      effort = str(data, 'reasoningEffort') ?? effort;
      title = str(data, 'title') ?? title;
      continue;
    }
    if (type === 'session.title_changed') { title = str(data, 'title') ?? title; continue; }
    if (type === 'session.model_change') { model = str(data, 'newModel') ?? model; effort = str(data, 'reasoningEffort'); continue; }
    if (type === 'assistant.usage' || type === 'session.shutdown' || type === 'session.usage_checkpoint') {
      const perCall = type === 'assistant.usage';
      const identity = str(data, 'apiCallId') ?? str(data, 'providerCallId') ?? str(data, 'serviceRequestId');
      if (perCall && identity && calls.has(identity)) continue;
      if (perCall && identity) calls.add(identity);
      // Checkpoints use an atomic accountingSnapshot; tolerate older direct modelMetrics too.
      const metrics = perCall ? { [str(data, 'model') ?? model]: { usage: data } }
        : rec(rec(data, 'accountingSnapshot'), 'modelMetrics') ?? rec(data, 'modelMetrics');
      if (!metrics) continue;
      let snapshotComplete = true;
      let hasUsage = false;
      let newCoverage = false;
      for (const [metricModel, value] of Object.entries(metrics)) {
        const usage = rec(asRecord(value), 'usage');
        if (!complete(usage)) { partial = true; snapshotComplete = false; continue; }
        hasUsage = true;
        const hadPrevious = accounted.has(metricModel);
        const previous = accounted.get(metricModel) ?? counters(undefined);
        const current = counters(usage);
        // Older runtime versions can reset process-local metrics on resume. A decrease
        // cannot establish whether the whole session reset or a stale snapshot replayed.
        // Retain known tokens and expose partial coverage instead of inventing a sum.
        if (!perCall && hadPrevious && KEYS.some((key) => usage?.[key] !== undefined && current[key] < previous[key])) {
          partial = true; snapshotComplete = false;
        }
        const delta = perCall ? current : Object.fromEntries(KEYS.map((key) => [key, Math.max(0, current[key] - previous[key])])) as Counters;
        const next = Object.fromEntries(KEYS.map((key) => [key, previous[key] + delta[key]])) as Counters;
        accounted.set(metricModel, next);
        // Preserve the first explicit all-zero metric as recorded telemetry; unchanged
        // later snapshots cannot certify assistant output after their original coverage.
        if (!perCall && hadPrevious && !KEYS.some((key) => delta[key] > 0)) continue;
        newCoverage = true;
        const id = perCall ? `copilot-call-${identity ?? eventId ?? line.seq}` : `copilot-aggregate-${line.seq}-${metricModel}`;
        billed.add(id);
        if (!perCall) aggregates.add(id);
        // This blank billing line has a genuine source byte range but no invented transcript text.
        hidden.add(line.seq);
        builder.take({ type: 'assistant', timestamp: ts, uuid: id, effort: str(data, 'reasoningEffort') ?? effort,
          message: { id, model: metricModel, usage: copilotUsage(delta), content: [] } }, line.seq, range);
      }
      if (hasUsage && snapshotComplete && newCoverage) {
        if (!perCall) coveredThrough = line.seq;
        else {
          const callId = str(data, 'apiCallId');
          if (callId) meteredCalls.add(callId);
        }
      }
      continue;
    }
    const normalized = normalizeCopilotLine(raw);
    if (!normalized) continue;
    normalized['uuid'] = eventId ?? `${file.sessionId}-${line.seq}`;
    if (normalized['type'] === 'assistant') {
      const message = rec(normalized, 'message') ?? {};
      const callId = str(data, 'apiCallId');
      assistantCoverage.push({ seq: line.seq, ...(callId ? { callId } : {}) });
      normalized['message'] = { ...message, id: callId ? `copilot-call-${callId}` : `copilot-visible-${eventId ?? line.seq}`, model: str(message, 'model') ?? model };
    }
    builder.take(normalized, line.seq, range);
    if (type === 'session.compaction_complete') builder.compactions.push({ seq: line.seq,
      turnIndex: builder.messages[builder.messages.length - 1]?.turnIndex ?? 0, ...(ts ? { ts } : {}) });
  }
  const transcript = builder.finish();
  if (title?.trim() && transcript.facts) transcript.facts.customTitle = title;
  transcript.requests = transcript.requests.filter((request) => billed.has(request.messageId));
  for (const request of transcript.requests) {
    if (aggregates.has(request.messageId)) {
      // Aggregate input cannot establish a single call's long-context tariff.
      request.contextTokens = 0;
    }
  }
  // A precise usage event covers its own API call only. It cannot certify earlier
  // responses whose telemetry is absent; only a cumulative snapshot can do that.
  if (partial || assistantCoverage.some((item) => item.seq > coveredThrough && (!item.callId || !meteredCalls.has(item.callId)))) {
    transcript.meta.usageIncomplete = true;
  }
  const seqs = new Set(transcript.requests.map((request) => request.seq));
  transcript.messages = transcript.messages.filter((message) => !hidden.has(message.seq));
  for (const message of transcript.messages) {
    if (message.requestSeq !== undefined && !seqs.has(message.requestSeq)) delete message.requestSeq;
  }
  for (const call of transcript.toolCalls) if (!seqs.has(call.requestSeq)) call.requestSeq = -1;
  return transcript;
}

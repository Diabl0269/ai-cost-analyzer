/**
 * One JSONL file → one `ParsedTranscript` (SPEC §3.2–3.5, §4).
 *
 * Single streaming pass collects lines into a builder, then a short finish pass deduplicates
 * assistant lines into billed requests and joins tool calls to their results. Legacy sidechain
 * lines (`isSidechain` + `agentId`) inside a main file are routed to their own builders and
 * surface as `embeddedAgents`, never as part of the main transcript's own totals.
 */
import { readJsonlLines } from '../jsonl.js';
import type {
  Attribution,
  ByteRange,
  DiscoveredFile,
  MessageKind,
  ParsedApiError,
  ParsedBlock,
  ParsedCompaction,
  ParsedHookRun,
  ParsedInjection,
  ParsedMessage,
  ParsedRequest,
  ParsedToolCall,
  ParsedTranscript,
  SessionFacts,
  TranscriptMeta,
} from '../types.js';
import { readAttachment, readStopHookSummary, type LinePosition } from './attachments.js';
import {
  previewOf,
  readAssistantContent,
  readUserContent,
  type AssistantContent,
  type RawToolResult,
} from './blocks.js';
import { applyFact, commandNamesOf } from './facts.js';
import { asRecord, count, num, parseJson, rec, str } from './raw.js';
import { cleanPrompt } from './titles.js';
import { readToolUseResult, splitMcpName, summarizeToolInput } from './tools.js';
import { contextTokensOf, inferenceGeoOf, iterationsOf, normalizeUsage, serviceTierOf, speedOf } from './usage.js';

export interface ParseTranscriptOptions {
  /** agent id for subagent / workflow-agent files; `null` (default) for a main transcript */
  agentId?: string | null;
}

/** Line types that carry no cost, no text and no facts. */
const IGNORED_TYPES = new Set([
  'last-prompt',
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
  'agent-color',
  'worktree-state',
  'agent-setting',
]);

const INTERRUPT = /^\s*\[Request interrupted by user/i;
const META_WRAPPED = /^\s*<(system-reminder|task-notification|local-command-[a-z-]+)>[\s\S]*<\/\1>\s*$/i;

export async function parseTranscript(
  file: DiscoveredFile,
  opts?: ParseTranscriptOptions,
): Promise<ParsedTranscript> {
  const agentId = opts?.agentId ?? null;
  const splitEmbedded = file.kind === 'main' && agentId === null;
  const root = new Builder(file, agentId, file.kind === 'main');
  const embedded = new Map<string, Builder>();

  for await (const line of readJsonlLines(file.path)) {
    root.meta.lineCount += 1;
    if (line.text.trim() === '') continue;
    const obj = asRecord(parseJson(line.text));
    if (!obj) {
      root.meta.parseErrors += 1;
      continue;
    }
    let target = root;
    if (splitEmbedded && obj['isSidechain'] === true) {
      const lineAgentId = str(obj, 'agentId');
      if (lineAgentId) {
        let builder = embedded.get(lineAgentId);
        if (!builder) {
          builder = new Builder(file, lineAgentId, false);
          embedded.set(lineAgentId, builder);
        }
        builder.meta.lineCount += 1;
        target = builder;
      }
    }
    target.take(obj, line.seq, { byteOffset: line.byteOffset, byteLength: line.byteLength });
  }

  const transcript = root.finish();
  if (embedded.size > 0) {
    const out: Record<string, ParsedTranscript> = {};
    for (const [id, builder] of embedded) out[id] = builder.finish();
    transcript.embeddedAgents = out;
  }
  return transcript;
}

interface AssistantLine {
  seq: number;
  turnIndex: number;
  range: ByteRange;
  uuid: string;
  parentUuid: string | null;
  ts: string;
  groupKey: string;
  messageId: string;
  requestId?: string;
  model: string;
  usage: Record<string, unknown> | undefined;
  outputTokens: number;
  apiBlockIndex?: number;
  content: AssistantContent;
  stopReason?: string;
  effort?: string;
  attribution: Attribution;
  isApiError: boolean;
  isAbortedMidStream: boolean;
}

interface ToolUseOccurrence {
  groupKey: string;
  turnIndex: number;
  ts: string;
  toolUseId: string;
  name: string;
  input: unknown;
  inputChars: number;
}

interface ToolResultRecord {
  seq: number;
  result: RawToolResult;
  toolUseResult: unknown;
}

export class Builder {
  readonly meta: TranscriptMeta = { lineCount: 0, parseErrors: 0 };
  readonly messages: ParsedMessage[] = [];
  readonly injections: ParsedInjection[] = [];
  readonly hooks: ParsedHookRun[] = [];
  readonly compactions: ParsedCompaction[] = [];
  readonly apiErrors: ParsedApiError[] = [];
  readonly facts: SessionFacts = {
    prLinks: [],
    localCommands: [],
    queuedOperations: 0,
    turnDurationsMs: [],
    awaySummaries: 0,
  };

  private readonly assistantLines = new Map<string, AssistantLine[]>();
  private readonly toolUses: ToolUseOccurrence[] = [];
  private readonly toolResults = new Map<string, ToolResultRecord>();
  private readonly effortCounts = new Map<string, number>();
  private readonly assistantMessageIndex = new Map<string, number[]>();
  private turnIndex = 0;
  private promptCount = 0;
  private firstPromptRaw: string | undefined;
  /** true once the current turn was opened by a human prompt (turn 0 never is). */
  private turnOpenedByPrompt = false;
  /** true once a billed request landed inside the current turn. */
  private requestSinceTurnStart = false;

  constructor(
    private readonly file: DiscoveredFile,
    private readonly agentId: string | null,
    private readonly collectFacts: boolean,
  ) {}

  take(obj: Record<string, unknown>, seq: number, range: ByteRange): void {
    const type = str(obj, 'type');
    if (type === undefined || IGNORED_TYPES.has(type)) return;
    this.envelope(obj);
    switch (type) {
      case 'user':
        this.user(obj, seq, range);
        return;
      case 'assistant':
        this.assistant(obj, seq, range);
        return;
      case 'system':
        this.system(obj, seq, range);
        return;
      case 'attachment':
        this.attachment(obj, seq, range);
        return;
      default:
        if (this.collectFacts) applyFact(this.facts, type, obj);
        return;
    }
  }

  private envelope(obj: Record<string, unknown>): void {
    const meta = this.meta;
    if (meta.cwd === undefined) {
      const cwd = str(obj, 'cwd');
      if (cwd) meta.cwd = cwd;
    }
    const gitBranch = str(obj, 'gitBranch');
    if (gitBranch) meta.gitBranch = gitBranch;
    const version = str(obj, 'version');
    if (version) meta.version = version;
    if (meta.entrypoint === undefined) {
      const entrypoint = str(obj, 'entrypoint');
      if (entrypoint) meta.entrypoint = entrypoint;
    }
    if (meta.sessionKind === undefined) {
      const sessionKind = str(obj, 'sessionKind');
      if (sessionKind) meta.sessionKind = sessionKind;
    }
    if (meta.slug === undefined) {
      const slug = str(obj, 'slug');
      if (slug) meta.slug = slug;
    }
  }

  private timestamps(ts: string | undefined): void {
    if (!ts) return;
    if (this.meta.firstTs === undefined || ts < this.meta.firstTs) this.meta.firstTs = ts;
    if (this.meta.lastTs === undefined || ts > this.meta.lastTs) this.meta.lastTs = ts;
  }

  // ── user ──────────────────────────────────────────────────────────────────

  private user(obj: Record<string, unknown>, seq: number, range: ByteRange): void {
    const ts = str(obj, 'timestamp');
    this.timestamps(ts);
    const message = rec(obj, 'message');
    const content = readUserContent(message?.['content']);
    const isMeta = obj['isMeta'] === true;
    const isCompact = obj['isCompactSummary'] === true;
    const kind = userKind(content.toolResults.length > 0, isCompact, isMeta, content.text);

    if (kind === 'prompt') {
      // A prompt only opens a new turn when the previous one actually did something: a queued
      // prompt or a skill-expansion user line that follows a prompt with no request in between
      // belongs to the turn already open, otherwise the transcript grows empty turns whose
      // preview duplicates the one before them.
      if (!this.turnOpenedByPrompt || this.requestSinceTurnStart) {
        this.turnIndex += 1;
        this.turnOpenedByPrompt = true;
        this.requestSinceTurnStart = false;
      }
      this.promptCount += 1;
      if (this.firstPromptRaw === undefined) this.firstPromptRaw = content.text;
    }
    const at: LinePosition = { seq, turnIndex: this.turnIndex, ...(ts ? { ts } : {}) };

    if (kind === 'prompt' && content.text) {
      this.injections.push({ ...at, kind: 'user_prompt', name: 'prompt', chars: content.text.length, charsSource: 'content' });
    } else if (kind === 'compact_summary' && content.text) {
      this.injections.push({
        ...at,
        kind: 'compact_summary',
        name: 'compact_summary',
        chars: content.text.length,
        charsSource: 'content',
      });
    }

    const sourceToolUseId = str(obj, 'sourceToolUseID');
    for (const result of content.toolResults) {
      const key = result.toolUseId || sourceToolUseId;
      if (!key) continue;
      this.toolResults.set(key, { seq, result, toolUseResult: obj['toolUseResult'] });
    }

    const visible = [content.text, ...content.toolResults.map((r) => r.text)].filter(Boolean).join('\n');
    this.pushMessage(obj, seq, range, {
      role: 'user',
      kind,
      turnIndex: this.turnIndex,
      // Harness wrappers are shown but never indexed.
      searchText: kind === 'meta' ? '' : visible,
      preview: previewOf(visible),
    });
  }

  // ── assistant ─────────────────────────────────────────────────────────────

  private assistant(obj: Record<string, unknown>, seq: number, range: ByteRange): void {
    const ts = str(obj, 'timestamp') ?? '';
    this.timestamps(ts || undefined);
    const message = rec(obj, 'message');
    const usage = rec(message, 'usage');
    const content = readAssistantContent(message?.['content']);
    const messageId = str(message, 'id') ?? '';
    const requestId = str(obj, 'requestId');
    const uuid = str(obj, 'uuid') ?? '';
    const groupKey = messageId || requestId || uuid;
    const effort = str(obj, 'effort');
    if (effort) this.effortCounts.set(effort, (this.effortCounts.get(effort) ?? 0) + 1);

    const attribution: Attribution = {};
    const skill = str(obj, 'attributionSkill');
    const plugin = str(obj, 'attributionPlugin');
    const mcpServer = str(obj, 'attributionMcpServer');
    const mcpTool = str(obj, 'attributionMcpTool');
    if (skill) attribution.skill = skill;
    if (plugin) attribution.plugin = plugin;
    if (mcpServer) attribution.mcpServer = mcpServer;
    if (mcpTool) attribution.mcpTool = mcpTool;

    const line: AssistantLine = {
      seq,
      turnIndex: this.turnIndex,
      range,
      uuid,
      parentUuid: str(obj, 'parentUuid') ?? null,
      ts,
      groupKey,
      messageId: messageId || groupKey,
      model: str(message, 'model') ?? '',
      usage,
      outputTokens: count(usage?.['output_tokens']),
      content,
      attribution,
      isApiError: obj['isApiErrorMessage'] === true,
      isAbortedMidStream: obj['isAbortedMidStream'] === true,
    };
    if (requestId) line.requestId = requestId;
    const apiBlockIndex = num(obj, 'apiBlockIndex');
    if (apiBlockIndex !== undefined) line.apiBlockIndex = apiBlockIndex;
    const stopReason = str(message, 'stop_reason');
    if (stopReason) line.stopReason = stopReason;
    if (effort) line.effort = effort;

    // Synthetic messages are client-side and never billed, so they do not close a turn either.
    if (line.model !== '<synthetic>') this.requestSinceTurnStart = true;

    const group = this.assistantLines.get(groupKey);
    if (group) group.push(line);
    else this.assistantLines.set(groupKey, [line]);

    for (const use of content.toolUses) {
      if (!use.id) continue;
      this.toolUses.push({
        groupKey,
        turnIndex: this.turnIndex,
        ts,
        toolUseId: use.id,
        name: use.name,
        input: use.input,
        inputChars: use.inputChars,
      });
    }

    const index = this.messages.length;
    const byGroup = this.assistantMessageIndex.get(groupKey);
    if (byGroup) byGroup.push(index);
    else this.assistantMessageIndex.set(groupKey, [index]);
    this.pushMessage(obj, seq, range, {
      role: 'assistant',
      kind: 'assistant',
      turnIndex: this.turnIndex,
      searchText: content.searchText,
      preview: previewOf(content.visibleText),
      ...(line.messageId ? { messageId: line.messageId } : {}),
    });
  }

  // ── system ────────────────────────────────────────────────────────────────

  private system(obj: Record<string, unknown>, seq: number, range: ByteRange): void {
    const ts = str(obj, 'timestamp');
    const subtype = str(obj, 'subtype') ?? 'informational';
    const at: LinePosition = { seq, turnIndex: this.turnIndex, ...(ts ? { ts } : {}) };
    switch (subtype) {
      case 'stop_hook_summary': {
        const outcome = readStopHookSummary(at, obj);
        this.injections.push(...outcome.injections);
        this.hooks.push(...outcome.hooks);
        break;
      }
      case 'turn_duration': {
        const durationMs = num(obj, 'durationMs');
        if (durationMs !== undefined) this.facts.turnDurationsMs.push(durationMs);
        break;
      }
      case 'api_error': {
        const error = rec(obj, 'error');
        const entry: ParsedApiError = { seq, ...(ts ? { ts } : {}) };
        const status = num(error, 'status');
        const message = str(error, 'message');
        const retryAttempt = num(obj, 'retryAttempt');
        const maxRetries = num(obj, 'maxRetries');
        if (status !== undefined) entry.status = status;
        if (message !== undefined) entry.message = message;
        if (retryAttempt !== undefined) entry.retryAttempt = retryAttempt;
        if (maxRetries !== undefined) entry.maxRetries = maxRetries;
        this.apiErrors.push(entry);
        break;
      }
      case 'compact_boundary': {
        const cm = rec(obj, 'compactMetadata');
        const entry: ParsedCompaction = { ...at };
        const trigger = str(cm, 'trigger');
        const preTokens = num(cm, 'preTokens');
        const postTokens = num(cm, 'postTokens');
        const durationMs = num(cm, 'durationMs');
        const dropped = num(cm, 'cumulativeDroppedTokens');
        if (trigger) entry.trigger = trigger;
        if (preTokens !== undefined) entry.preTokens = preTokens;
        if (postTokens !== undefined) entry.postTokens = postTokens;
        if (durationMs !== undefined) entry.durationMs = durationMs;
        if (dropped !== undefined) entry.cumulativeDroppedTokens = dropped;
        this.compactions.push(entry);
        break;
      }
      case 'away_summary':
        this.facts.awaySummaries += 1;
        break;
      case 'local_command': {
        for (const name of commandNamesOf(str(obj, 'content') ?? '')) this.facts.localCommands.push(name);
        break;
      }
      default:
        break;
    }
    this.pushMessage(obj, seq, range, {
      role: 'system',
      kind: 'system',
      turnIndex: this.turnIndex,
      searchText: '',
      preview: previewOf(str(obj, 'content') ?? ''),
      subtype,
    });
  }

  // ── attachment ────────────────────────────────────────────────────────────

  private attachment(obj: Record<string, unknown>, seq: number, range: ByteRange): void {
    const ts = str(obj, 'timestamp');
    const attachment = rec(obj, 'attachment');
    const at: LinePosition = { seq, turnIndex: this.turnIndex, ...(ts ? { ts } : {}) };
    let preview = '';
    let subtype = 'unknown';
    if (attachment) {
      subtype = str(attachment, 'type') ?? 'unknown';
      const outcome = readAttachment(at, attachment, obj['rendered']);
      this.injections.push(...outcome.injections);
      this.hooks.push(...outcome.hooks);
      preview = outcome.preview;
    }
    this.pushMessage(obj, seq, range, {
      role: 'attachment',
      kind: 'attachment',
      turnIndex: this.turnIndex,
      // Harness noise: shown in the transcript, deliberately never indexed for search.
      searchText: '',
      preview: previewOf(preview),
      subtype,
    });
  }

  private pushMessage(
    obj: Record<string, unknown>,
    seq: number,
    range: ByteRange,
    fields: {
      role: ParsedMessage['role'];
      kind: MessageKind;
      turnIndex: number;
      searchText: string;
      preview: string;
      subtype?: string;
      messageId?: string;
    },
  ): void {
    const ts = str(obj, 'timestamp');
    const message: ParsedMessage = {
      seq,
      turnIndex: fields.turnIndex,
      uuid: str(obj, 'uuid') ?? '',
      parentUuid: str(obj, 'parentUuid') ?? null,
      role: fields.role,
      kind: fields.kind,
      range,
      searchText: fields.searchText,
      preview: fields.preview,
      isMeta: obj['isMeta'] === true,
      isSidechain: obj['isSidechain'] === true,
    };
    if (ts) message.ts = ts;
    if (fields.subtype) message.subtype = fields.subtype;
    if (fields.messageId) message.messageId = fields.messageId;
    this.messages.push(message);
  }

  // ── finish ────────────────────────────────────────────────────────────────

  finish(): ParsedTranscript {
    const requests = this.buildRequests();
    const requestSeqByGroup = new Map<string, number>();
    for (const [groupKey, request] of requests.byGroup) requestSeqByGroup.set(groupKey, request.seq);
    for (const [groupKey, indexes] of this.assistantMessageIndex) {
      const requestSeq = requestSeqByGroup.get(groupKey);
      if (requestSeq === undefined) continue;
      for (const i of indexes) {
        const message = this.messages[i];
        if (message) message.requestSeq = requestSeq;
      }
    }

    const meta = this.meta;
    const effort = mostCommon(this.effortCounts);
    if (effort) meta.effort = effort;
    // Every transcript carries its own cleaned first prompt: main transcripts use it for the
    // session title, agent transcripts to label a row whose meta.json has no description.
    const cleanedFirstPrompt =
      this.firstPromptRaw === undefined ? '' : cleanPrompt(this.firstPromptRaw);
    if (cleanedFirstPrompt) meta.firstPrompt = cleanedFirstPrompt;

    const transcript: ParsedTranscript = {
      file: this.file,
      agentId: this.agentId,
      meta,
      requests: requests.list,
      messages: this.messages,
      toolCalls: this.buildToolCalls(requestSeqByGroup),
      injections: this.injections,
      hooks: this.hooks,
      compactions: this.compactions,
      apiErrors: this.apiErrors,
      promptCount: this.promptCount,
    };
    if (this.collectFacts) {
      if (cleanedFirstPrompt) this.facts.firstPrompt = cleanedFirstPrompt;
      transcript.facts = this.facts;
    }
    return transcript;
  }

  private buildRequests(): { list: ParsedRequest[]; byGroup: Map<string, ParsedRequest> } {
    const byGroup = new Map<string, ParsedRequest>();
    for (const [groupKey, lines] of this.assistantLines) {
      const ordered = orderLines(lines);
      const billing = billingLine(lines);
      const first = lines[0];
      if (!first || !billing) continue;
      const usage = normalizeUsage(billing.usage);
      const iterations = iterationsOf(billing.usage, billing.model);
      const blocks: ParsedBlock[] = [];
      let hasFallbackBlock = false;
      for (const line of ordered) {
        blocks.push(...line.content.blocks);
        hasFallbackBlock ||= line.content.hasFallbackBlock;
      }
      const request: ParsedRequest = {
        seq: first.seq,
        turnIndex: first.turnIndex,
        messageId: billing.messageId || groupKey,
        uuid: first.uuid,
        parentUuid: first.parentUuid,
        ts: first.ts,
        model: billing.model,
        usage,
        speed: speedOf(billing.usage),
        serviceTier: serviceTierOf(billing.usage),
        inferenceGeo: inferenceGeoOf(billing.usage),
        blocks,
        isSynthetic: billing.model === '<synthetic>',
        isApiError: lines.some((l) => l.isApiError),
        isAbortedMidStream: lines.some((l) => l.isAbortedMidStream),
        isFallback: hasFallbackBlock || (iterations?.some((it) => it.type === 'fallback_message') ?? false),
        attribution: billing.attribution,
        lines: ordered.map((l) => l.range),
        contextTokens: contextTokensOf(usage),
      };
      if (billing.requestId) request.requestId = billing.requestId;
      if (iterations) request.iterations = iterations;
      if (billing.stopReason) request.stopReason = billing.stopReason;
      if (billing.effort) request.effort = billing.effort;
      byGroup.set(groupKey, request);
    }
    const list = [...byGroup.values()].sort((a, b) => a.seq - b.seq);
    return { list, byGroup };
  }

  private buildToolCalls(requestSeqByGroup: Map<string, number>): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    for (const use of this.toolUses) {
      const record = this.toolResults.get(use.toolUseId);
      const links = readToolUseResult(use.name, record?.toolUseResult, use.input);
      const call: ParsedToolCall = {
        toolUseId: use.toolUseId,
        name: use.name,
        requestSeq: requestSeqByGroup.get(use.groupKey) ?? -1,
        turnIndex: use.turnIndex,
        ts: use.ts,
        inputChars: use.inputChars,
        inputSummary: summarizeToolInput(use.name, use.input),
        resultChars: record?.result.chars ?? 0,
        resultImages: record?.result.images ?? 0,
        resultShape: record?.result.shape ?? 'missing',
        isError: record?.result.isError ?? false,
        resultPreview: previewOf(record?.result.text ?? ''),
      };
      const mcp = splitMcpName(use.name);
      if (mcp.mcpServer) call.mcpServer = mcp.mcpServer;
      if (mcp.mcpTool) call.mcpTool = mcp.mcpTool;
      if (record) call.resultSeq = record.seq;
      if (links.childAgentId) call.childAgentId = links.childAgentId;
      if (links.childRunId) call.childRunId = links.childRunId;
      if (links.childModel) call.childModel = links.childModel;
      if (links.childDescription) call.childDescription = links.childDescription;
      if (links.persistedOutputPath) call.persistedOutputPath = links.persistedOutputPath;
      if (links.durationMs !== undefined) call.durationMs = links.durationMs;
      calls.push(call);
    }
    return calls.sort((a, b) => a.requestSeq - b.requestSeq);
  }
}

function userKind(hasToolResult: boolean, isCompact: boolean, isMeta: boolean, text: string): MessageKind {
  if (hasToolResult) return 'tool_result';
  if (isCompact) return 'compact_summary';
  if (INTERRUPT.test(text)) return 'interrupt';
  if (isMeta) return 'meta';
  if (text.trim() === '') return 'meta';
  if (META_WRAPPED.test(text)) return 'meta';
  return 'prompt';
}

/** Content blocks merge in `apiBlockIndex` order when the harness recorded it, else file order. */
function orderLines(lines: AssistantLine[]): AssistantLine[] {
  if (lines.length < 2) return lines;
  if (lines.some((l) => l.apiBlockIndex === undefined)) return lines;
  return [...lines].sort((a, b) => (a.apiBlockIndex ?? 0) - (b.apiBlockIndex ?? 0));
}

/** The billed line of a message: largest `output_tokens`, ties resolved by the last line in file order. */
function billingLine(lines: AssistantLine[]): AssistantLine | undefined {
  let best: AssistantLine | undefined;
  for (const line of lines) {
    if (best === undefined || line.outputTokens >= best.outputTokens) best = line;
  }
  return best;
}

function mostCommon(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, n] of counts) {
    if (n > bestCount) {
      best = value;
      bestCount = n;
    }
  }
  return best;
}

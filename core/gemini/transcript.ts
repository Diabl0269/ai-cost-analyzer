/**
 * Google Antigravity (`transcript_full.jsonl` / `transcript.jsonl`) and Gemini CLI
 * (`session-*.jsonl` / `session-*.json`) → the shared `ParsedTranscript` contract.
 * Display lines are addressed by virtual sequence number (`0..N-1`), matching OpenCode and VS Code journals.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJsonlLines } from '../jsonl.js';
import { asRecord, count, list, num, parseJson, rec, str } from '../parse/raw.js';
import { Builder } from '../parse/transcript.js';
import type { AgentMeta, DiscoveredFile, ParsedTranscript } from '../types.js';
import { antigravityPrompt } from './prompts.js';
import { loadAntigravitySummaryForTranscript } from './summaries.js';

type Raw = Record<string, unknown>;

const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh)$/i;
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

export function isGeminiSessionId(sessionId: string): boolean {
  return sessionId.startsWith('gemini-') || sessionId.startsWith('antigravity-');
}

export function isAntigravityFilePath(filePath: string): boolean {
  const base = path.basename(filePath);
  return base === 'transcript.jsonl' || base === 'transcript_full.jsonl';
}

/**
 * Antigravity `PLANNER_RESPONSE` reports `input_tokens` already excluding `cache_read_tokens`,
 * and `output_tokens` already including thinking tokens.
 */
export function antigravityUsage(raw: Raw): Raw | undefined {
  const hasAny =
    typeof raw['input_tokens'] === 'number' ||
    typeof raw['output_tokens'] === 'number' ||
    typeof raw['cache_read_tokens'] === 'number' ||
    typeof raw['cache_write_tokens'] === 'number' ||
    typeof raw['cache_creation_tokens'] === 'number';
  if (!hasAny) return undefined;
  const input = Math.max(0, count(raw['input_tokens']));
  const cacheRead = Math.max(0, count(raw['cache_read_tokens']));
  const cacheWrite = Math.max(0, count(raw['cache_write_tokens'] ?? raw['cache_creation_tokens']));
  const output = Math.max(0, count(raw['output_tokens']));
  const thinking =
    typeof raw['thinking_tokens'] === 'number'
      ? Math.min(output, Math.max(0, count(raw['thinking_tokens'])))
      : 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens_details: { thinking_tokens: thinking },
  };
}

/**
 * Gemini CLI `tokens` maps Gemini API `UsageMetadata`:
 * `input` (`promptTokenCount`) includes `cached` (`cachedContentTokenCount`), `tool` is
 * `toolUsePromptTokenCount`, and `thoughts` (`thoughtsTokenCount`) is separate from `output`
 * (`candidatesTokenCount`) — both bill at the output rate.
 */
export function geminiCliUsage(raw: Raw): Raw | undefined {
  const hasAny =
    typeof raw['input'] === 'number' ||
    typeof raw['prompt'] === 'number' ||
    typeof raw['output'] === 'number' ||
    typeof raw['candidates'] === 'number' ||
    typeof raw['cached'] === 'number' ||
    typeof raw['thoughts'] === 'number';
  if (!hasAny) return undefined;
  const rawInput = Math.max(0, count(raw['input'] ?? raw['prompt']));
  const tool = Math.max(0, count(raw['tool']));
  const cached = Math.max(0, count(raw['cached']));
  const candidates = Math.max(0, count(raw['output'] ?? raw['candidates']));
  const thoughts = Math.max(0, count(raw['thoughts']));
  const total = Math.max(0, count(raw['total']));
  const promptTotal = rawInput + tool;
  // Guard against future callers that pre-subtract cached from input while reporting total.
  const inputExcludesCached =
    cached > 0 && total > 0 && total === promptTotal + cached + candidates + thoughts;
  const cacheRead = inputExcludesCached ? cached : Math.min(promptTotal, cached);
  const uncachedInput = inputExcludesCached ? promptTotal : Math.max(0, promptTotal - cacheRead);
  return {
    input_tokens: uncachedInput,
    output_tokens: candidates + thoughts,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
    output_tokens_details: { thinking_tokens: thoughts },
  };
}

function effortOfModel(model: string): string | undefined {
  const m = EFFORT_SUFFIX.exec(model.trim());
  return m?.[1]?.toLowerCase();
}

function normalizeToolArgs(rawArgs: unknown): unknown {
  const record = asRecord(rawArgs);
  if (!record) return rawArgs ?? {};
  // Compact `transcript.jsonl` stringifies individual arg values (`"\"/path\""`, `"5000"`).
  const out: Raw = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        trimmed === 'true' ||
        trimmed === 'false' ||
        /^-?\d+(?:\.\d+)?$/.test(trimmed) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        const parsed = parseJson(trimmed);
        out[k] = parsed !== null ? parsed : v;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

function isAntigravityToolError(step: Raw, content: string): boolean {
  if (step['status'] === 'ERROR' || Boolean(step['error'])) return true;
  if (typeof step['exit_code'] === 'number' && step['exit_code'] !== 0) return true;
  return /^(?:Command (?:failed to run|exited with code [1-9])|Encountered error in tool execution:)/m.test(content);
}

export interface ReconstructedSession {
  lines: Raw[];
  billed: Set<string>;
  unbilledOutput: boolean;
  recordedModels: Set<string>;
  injections: { seq: number; ts?: string; name: string; chars: number }[];
  compactions: { seq: number; ts?: string; trigger: string }[];
  apiErrors: { seq: number; ts?: string; status?: number; message?: string }[];
  subagentSpawns: Map<string, { agentId?: string; agentType?: string; description?: string; model?: string }>;
  meta: {
    cwd?: string;
    entrypoint?: string;
    sessionKind?: string;
    aiTitle?: string;
    agentName?: string;
    parseErrors: number;
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | undefined;
}

async function buildAntigravityLines(filePath: string, rawConversationId?: string): Promise<ReconstructedSession> {
  const lines: Raw[] = [];
  const billed = new Set<string>();
  const recordedModels = new Set<string>();
  const injections: ReconstructedSession['injections'] = [];
  const compactions: ReconstructedSession['compactions'] = [];
  const apiErrors: ReconstructedSession['apiErrors'] = [];
  const subagentSpawns = new Map<string, { agentId?: string; agentType?: string; description?: string; model?: string }>();
  let unbilledOutput = false;
  let parseErrors = 0;
  let pendingTools: PendingToolCall[] = [];

  for await (const rawLine of readJsonlLines(filePath)) {
    if (!rawLine.text.trim()) continue;
    const step = asRecord(parseJson(rawLine.text));
    if (!step) {
      parseErrors += 1;
      continue;
    }
    const source = str(step, 'source') ?? '';
    const type = str(step, 'type') ?? '';
    const ts = str(step, 'created_at');
    const stepIndex = num(step, 'step_index') ?? rawLine.seq;

    if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
      pendingTools = [];
      const rawContent = str(step, 'content') ?? '';
      const prompt = antigravityPrompt(rawContent);
      const seq = lines.length;
      lines.push({
        type: 'user',
        uuid: `agy-step-${stepIndex}`,
        ...(ts ? { timestamp: ts } : {}),
        isMeta: prompt.isMeta,
        message: { content: prompt.isMeta ? rawContent : prompt.text },
      });
      if (prompt.harnessChars > 0) {
        injections.push({ seq, ...(ts ? { ts } : {}), name: 'antigravity_context', chars: prompt.harnessChars });
      }
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      pendingTools = [];
      const msgId = `agy-msg-${stepIndex}`;
      const model = str(step, 'model') ?? '';
      if (model) recordedModels.add(model);
      const effort = model ? effortOfModel(model) : undefined;
      const thinking = str(step, 'thinking');
      const content = str(step, 'content');
      const rawCalls = list(step, 'tool_calls');
      const usage = antigravityUsage(step);

      const stepLines: Raw[] = [];
      const envelope = (blocks: Raw[]): Raw => ({
        type: 'assistant',
        uuid: `${msgId}-${stepLines.length}`,
        ...(ts ? { timestamp: ts } : {}),
        ...(effort ? { effort } : {}),
        message: { id: msgId, model, content: blocks },
      });

      if (thinking) stepLines.push(envelope([{ type: 'thinking', thinking }]));
      if (content) stepLines.push(envelope([{ type: 'text', text: content }]));
      for (const [idx, rawCall] of rawCalls.entries()) {
        const call = asRecord(rawCall);
        if (!call) continue;
        const callName = str(call, 'name') ?? 'unknown';
        const callId = str(call, 'id') ?? `${msgId}-tool-${idx}`;
        const normalizedArgs = normalizeToolArgs(call['args']);
        const argsRec = asRecord(normalizedArgs);
        stepLines.push(envelope([{ type: 'tool_use', id: callId, name: callName, input: normalizedArgs }]));
        pendingTools.push({ id: callId, name: callName, args: argsRec });
        if (callName === 'invoke_subagent' && argsRec) {
          const spawn: { agentId?: string; agentType?: string; description?: string; model?: string } = {};
          const agentType = str(argsRec, 'TypeName');
          const role = str(argsRec, 'Role');
          const reqModel = str(argsRec, 'Model');
          if (agentType) spawn.agentType = agentType;
          if (role) spawn.description = role;
          if (reqModel && reqModel !== 'inherit') spawn.model = reqModel;
          subagentSpawns.set(callId, spawn);
        }
      }

      if (stepLines.length === 0 && (usage || model)) stepLines.push(envelope([]));
      const last = stepLines[stepLines.length - 1];
      if (last && usage) {
        (last['message'] as Raw)['usage'] = usage;
        billed.add(msgId);
      } else if (stepLines.length > 0 && step['status'] !== 'ERROR') {
        unbilledOutput = true;
      }
      lines.push(...stepLines);
      if (step['status'] === 'ERROR') {
        apiErrors.push({
          seq: Math.max(0, lines.length - 1),
          ...(ts ? { ts } : {}),
          ...(typeof step['error_code'] === 'number' ? { status: step['error_code'] } : {}),
          ...(str(step, 'error') ? { message: str(step, 'error')! } : {}),
        });
      }
      continue;
    }

    if (source === 'MODEL' && pendingTools.length > 0) {
      const pending = pendingTools.shift()!;
      const resultText = str(step, 'content') ?? str(step, 'error') ?? '';
      const isError = isAntigravityToolError(step, resultText);
      if (pending.name === 'invoke_subagent') {
        const spawn = subagentSpawns.get(pending.id);
        const idMatch = UUID_RE.exec(resultText);
        if (spawn && idMatch?.[1]) spawn.agentId = idMatch[1];
      }
      lines.push({
        type: 'user',
        uuid: `agy-step-${stepIndex}`,
        ...(ts ? { timestamp: ts } : {}),
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: pending.id,
              content: resultText,
              is_error: isError,
            },
          ],
        },
      });
      continue;
    }

    if (source === 'SYSTEM') {
      const sysContent = str(step, 'content') ?? str(step, 'error') ?? '';
      const seq = lines.length;
      if (type === 'CHECKPOINT') {
        compactions.push({ seq, ...(ts ? { ts } : {}), trigger: type.toLowerCase() });
      } else if (type === 'ERROR_MESSAGE') {
        apiErrors.push({
          seq,
          ...(ts ? { ts } : {}),
          ...(typeof step['error_code'] === 'number' ? { status: step['error_code'] } : {}),
          ...(sysContent ? { message: sysContent } : {}),
        });
      }
      if (sysContent || type === 'CHECKPOINT' || type === 'ERROR_MESSAGE') {
        lines.push({
          type: 'system',
          subtype: type.toLowerCase(),
          uuid: `agy-step-${stepIndex}`,
          ...(ts ? { timestamp: ts } : {}),
          content: sysContent,
          isMeta: true,
        });
      }
    }
  }

  const convId = rawConversationId ?? inferAntigravityIdFromPath(filePath);
  const summary = convId ? loadAntigravitySummaryForTranscript(filePath, convId) : undefined;
  const meta: ReconstructedSession['meta'] = {
    entrypoint: summary?.appDataDir === 'antigravity-cli' ? 'antigravity-cli' : 'antigravity',
    parseErrors,
  };
  if (summary?.cwd) meta.cwd = summary.cwd;
  if (summary?.title) meta.aiTitle = summary.title;
  if (summary?.agentName) meta.agentName = summary.agentName;

  return {
    lines,
    billed,
    unbilledOutput,
    recordedModels,
    injections,
    compactions,
    apiErrors,
    subagentSpawns,
    meta,
  };
}

function inferAntigravityIdFromPath(filePath: string): string | undefined {
  const logsDir = path.dirname(filePath);
  const sysDir = path.dirname(logsDir);
  if (path.basename(sysDir) === '.system_generated') return path.basename(path.dirname(sysDir));
  return undefined;
}

function textFromGeminiParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      const r = asRecord(item);
      return str(r, 'text') ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function formatGeminiToolResult(call: Raw): string {
  const display = str(call, 'resultDisplay');
  if (display !== undefined && display.length > 0) return display;
  const res = call['result'];
  if (typeof res === 'string') return res;
  if (Array.isArray(res)) {
    const parts: string[] = [];
    for (const item of res) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      const r = asRecord(item);
      if (!r) continue;
      const text = str(r, 'text');
      if (text) {
        parts.push(text);
        continue;
      }
      const fnResp = rec(r, 'functionResponse');
      const response = rec(fnResp, 'response');
      const output = str(response, 'output') ?? str(response, 'content') ?? str(response, 'error');
      if (output !== undefined) parts.push(output);
      else if (response) parts.push(JSON.stringify(response));
    }
    if (parts.length > 0) return parts.join('\n');
  }
  const resObj = asRecord(res);
  if (resObj) {
    const fnResp = rec(resObj, 'functionResponse');
    const response = rec(fnResp, 'response') ?? resObj;
    const output = str(response, 'output') ?? str(response, 'content') ?? str(response, 'error');
    if (output !== undefined) return output;
    return JSON.stringify(response);
  }
  return '';
}

function applySetPatch(state: { messages: Raw[]; summary?: string; cwd?: string }, patch: Raw): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'messages' && Array.isArray(value)) {
      state.messages = value.map((item) => asRecord(item)).filter((item): item is Raw => item !== null);
      continue;
    }
    if (key === 'summary' && typeof value === 'string' && value.trim()) {
      state.summary = value.trim();
      continue;
    }
    const dotted = /^messages\.(\d+)(?:\.(.+))?$/.exec(key);
    if (dotted) {
      const idx = Number(dotted[1]);
      const field = dotted[2];
      if (!field) {
        const msg = asRecord(value);
        if (msg) state.messages[idx] = msg;
      } else {
        const target = state.messages[idx] ?? {};
        target[field] = value;
        state.messages[idx] = target;
      }
    }
  }
}

async function buildGeminiCliLines(filePath: string): Promise<ReconstructedSession> {
  const state: { messages: Raw[]; summary?: string; cwd?: string; kind?: string } = { messages: [] };
  let parseErrors = 0;

  if (filePath.endsWith('.json')) {
    const root = asRecord(parseJson(await readFile(filePath, 'utf8')));
    if (!root) {
      parseErrors += 1;
    } else {
      const summary = str(root, 'summary');
      const kind = str(root, 'kind');
      const dirs = list(root, 'directories');
      const cwd = str(root, 'cwd') ?? str(root, 'projectPath') ?? (typeof dirs[0] === 'string' ? dirs[0] : undefined);
      if (summary?.trim()) state.summary = summary.trim();
      if (kind) state.kind = kind;
      if (cwd && path.isAbsolute(cwd)) state.cwd = cwd;
      state.messages = list(root, 'messages')
        .map((m) => asRecord(m))
        .filter((m): m is Raw => m !== null);
    }
  } else {
    for await (const rawLine of readJsonlLines(filePath)) {
      if (!rawLine.text.trim()) continue;
      const obj = asRecord(parseJson(rawLine.text));
      if (!obj) {
        parseErrors += 1;
        continue;
      }
      const patch = rec(obj, '$set');
      if (patch) {
        applySetPatch(state, patch);
        continue;
      }
      if (typeof obj['sessionId'] === 'string' && obj['type'] === undefined) {
        const summary = str(obj, 'summary');
        const kind = str(obj, 'kind');
        const dirs = list(obj, 'directories');
        const cwd = str(obj, 'cwd') ?? str(obj, 'projectPath') ?? (typeof dirs[0] === 'string' ? dirs[0] : undefined);
        if (summary?.trim()) state.summary = summary.trim();
        if (kind) state.kind = kind;
        if (cwd && path.isAbsolute(cwd)) state.cwd = cwd;
        if (Array.isArray(obj['messages'])) {
          state.messages = (obj['messages'] as unknown[])
            .map((m) => asRecord(m))
            .filter((m): m is Raw => m !== null);
        }
        continue;
      }
      if (typeof obj['type'] === 'string') {
        const id = str(obj, 'id');
        const existingIdx = id ? state.messages.findIndex((m) => str(m, 'id') === id) : -1;
        if (existingIdx >= 0) state.messages[existingIdx] = { ...state.messages[existingIdx], ...obj };
        else state.messages.push(obj);
      }
    }
  }

  // Resolve `.project_root` alongside `chats` when the file itself didn't store `cwd`.
  if (!state.cwd) {
    const parent = path.dirname(filePath);
    const projectDir = path.basename(parent) === 'chats' ? path.dirname(parent) : parent;
    try {
      const marker = (await readFile(path.join(projectDir, '.project_root'), 'utf8')).trim();
      if (marker && path.isAbsolute(marker)) state.cwd = marker;
    } catch {
      // Optional marker.
    }
  }

  const lines: Raw[] = [];
  const billed = new Set<string>();
  const recordedModels = new Set<string>();
  const apiErrors: ReconstructedSession['apiErrors'] = [];
  let unbilledOutput = false;

  for (const [msgIndex, msg] of state.messages.entries()) {
    const type = str(msg, 'type') ?? str(msg, 'role') ?? '';
    const msgId = str(msg, 'id') ?? `gemini-msg-${msgIndex}`;
    const ts = str(msg, 'timestamp');

    if (type === 'user') {
      const text = textFromGeminiParts(msg['content']);
      lines.push({
        type: 'user',
        uuid: msgId,
        ...(ts ? { timestamp: ts } : {}),
        message: { content: text },
      });
      continue;
    }

    if (type === 'gemini' || type === 'model' || type === 'assistant') {
      const model = str(msg, 'model') ?? '';
      if (model) recordedModels.add(model);
      const effort = model ? effortOfModel(model) : undefined;
      const tokens = rec(msg, 'tokens');
      const usage = tokens ? geminiCliUsage(tokens) : undefined;
      const thoughts = list(msg, 'thoughts');
      const text = textFromGeminiParts(msg['content']);
      const toolCalls = list(msg, 'toolCalls');

      const assistantGroup: Raw[] = [];
      const toolResults: Raw[] = [];
      const envelope = (blocks: Raw[], blockTs?: string): Raw => ({
        type: 'assistant',
        uuid: `${msgId}-${assistantGroup.length}`,
        ...((blockTs ?? ts) ? { timestamp: (blockTs ?? ts)! } : {}),
        ...(effort ? { effort } : {}),
        message: { id: msgId, model, content: blocks },
      });

      if (thoughts.length > 0) {
        const thoughtText = thoughts
          .map((item) => {
            if (typeof item === 'string') return item;
            const r = asRecord(item);
            const subj = str(r, 'subject');
            const desc = str(r, 'description') ?? str(r, 'text');
            return [subj, desc].filter(Boolean).join(': ');
          })
          .filter(Boolean)
          .join('\n\n');
        if (thoughtText) assistantGroup.push(envelope([{ type: 'thinking', thinking: thoughtText }]));
      }

      if (text) assistantGroup.push(envelope([{ type: 'text', text }]));

      for (const [callIdx, rawCall] of toolCalls.entries()) {
        const call = asRecord(rawCall);
        if (!call) continue;
        const callId = str(call, 'id') ?? `${msgId}-call-${callIdx}`;
        const callName = str(call, 'name') ?? 'unknown';
        const callTs = str(call, 'timestamp') ?? ts;
        const args = call['args'] ?? {};
        assistantGroup.push(envelope([{ type: 'tool_use', id: callId, name: callName, input: args }], callTs));
        const status = str(call, 'status');
        if (status !== 'pending' && status !== 'executing' && status !== 'scheduled') {
          toolResults.push({
            type: 'user',
            uuid: `${callId}-result`,
            ...(callTs ? { timestamp: callTs } : {}),
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: callId,
                  content: formatGeminiToolResult(call),
                  is_error: status === 'error' || status === 'failed' || status === 'cancelled',
                },
              ],
            },
          });
        }
      }

      if (assistantGroup.length === 0 && (usage || model)) assistantGroup.push(envelope([]));
      const last = assistantGroup[assistantGroup.length - 1];
      if (last && usage) {
        (last['message'] as Raw)['usage'] = usage;
        billed.add(msgId);
      } else if (assistantGroup.length > 0) {
        unbilledOutput = true;
      }
      lines.push(...assistantGroup, ...toolResults);
      continue;
    }

    if (type === 'error') {
      const errText = textFromGeminiParts(msg['content']);
      const seq = lines.length;
      apiErrors.push({ seq, ...(ts ? { ts } : {}), ...(errText ? { message: errText } : {}) });
      if (errText) {
        lines.push({
          type: 'system',
          subtype: 'error',
          uuid: msgId,
          ...(ts ? { timestamp: ts } : {}),
          content: errText,
          isMeta: true,
        });
      }
      continue;
    }

    if (type === 'info' || type === 'warning') {
      const infoText = textFromGeminiParts(msg['content']);
      if (infoText) {
        lines.push({
          type: 'system',
          subtype: type,
          uuid: msgId,
          ...(ts ? { timestamp: ts } : {}),
          content: infoText,
          isMeta: true,
        });
      }
    }
  }

  const meta: ReconstructedSession['meta'] = {
    entrypoint: 'gemini-cli',
    parseErrors,
  };
  if (state.cwd) meta.cwd = state.cwd;
  if (state.kind) meta.sessionKind = state.kind;
  if (state.summary) meta.aiTitle = state.summary;

  return {
    lines,
    billed,
    unbilledOutput,
    recordedModels,
    injections: [],
    compactions: [],
    apiErrors,
    subagentSpawns: new Map(),
    meta,
  };
}

export async function reconstructGeminiSession(
  filePath: string,
  rawConversationId?: string,
): Promise<ReconstructedSession> {
  return isAntigravityFilePath(filePath)
    ? await buildAntigravityLines(filePath, rawConversationId)
    : await buildGeminiCliLines(filePath);
}

/** Reconstructs the display lines of one Gemini CLI or Antigravity transcript for the viewer. */
export async function readGeminiSessionLines(filePath: string): Promise<Raw[]> {
  return (await reconstructGeminiSession(filePath)).lines;
}

export async function parseGeminiTranscript(
  file: DiscoveredFile,
  agentId: string | null = null,
  agentMetaOut?: Record<string, AgentMeta>,
): Promise<ParsedTranscript> {
  const rawId =
    agentId ??
    (file.sessionId.startsWith('antigravity-')
      ? file.sessionId.slice('antigravity-'.length)
      : file.sessionId.startsWith('gemini-')
        ? file.sessionId.slice('gemini-'.length)
        : undefined);
  const reconstructed = await reconstructGeminiSession(file.path, isAntigravityFilePath(file.path) ? rawId : undefined);
  const builder = new Builder(file, agentId, agentId === null);
  if (reconstructed.meta.entrypoint) builder.meta.entrypoint = reconstructed.meta.entrypoint;
  if (reconstructed.meta.cwd) builder.meta.cwd = reconstructed.meta.cwd;
  if (reconstructed.meta.sessionKind) builder.meta.sessionKind = reconstructed.meta.sessionKind;
  builder.meta.parseErrors = reconstructed.meta.parseErrors;
  builder.meta.lineCount = reconstructed.lines.length;

  if (agentId === null) {
    if (reconstructed.meta.aiTitle) builder.facts.aiTitle = reconstructed.meta.aiTitle;
    if (reconstructed.meta.agentName) builder.facts.agentName = reconstructed.meta.agentName;
  } else if (agentMetaOut) {
    const existing = agentMetaOut[agentId] ?? {};
    const desc = reconstructed.meta.aiTitle ?? reconstructed.meta.agentName;
    if (desc && !existing.description) existing.description = desc;
    agentMetaOut[agentId] = existing;
  }

  for (const [seq, line] of reconstructed.lines.entries()) {
    builder.take(line, seq, { byteOffset: 0, byteLength: 0 });
  }

  for (const inj of reconstructed.injections) {
    const msg = builder.messages.find((m) => m.seq === inj.seq);
    builder.injections.push({
      seq: inj.seq,
      turnIndex: msg?.turnIndex ?? 0,
      ...(inj.ts ? { ts: inj.ts } : {}),
      kind: 'other',
      name: inj.name,
      chars: inj.chars,
      charsSource: 'content',
    });
  }

  const usedCompSeqs = new Set<number>(builder.compactions.map((c) => c.seq));
  for (const comp of reconstructed.compactions) {
    let seq = comp.seq;
    while (usedCompSeqs.has(seq)) seq += 1;
    usedCompSeqs.add(seq);
    const turnIndex =
      builder.messages.filter((m) => m.seq <= seq).at(-1)?.turnIndex ?? 0;
    builder.compactions.push({
      seq,
      turnIndex,
      ...(comp.ts ? { ts: comp.ts } : {}),
      trigger: comp.trigger,
    });
  }

  const usedErrSeqs = new Set<number>(builder.apiErrors.map((e) => e.seq));
  for (const err of reconstructed.apiErrors) {
    let seq = err.seq;
    while (usedErrSeqs.has(seq)) seq += 1;
    usedErrSeqs.add(seq);
    builder.apiErrors.push({
      seq,
      ...(err.ts ? { ts: err.ts } : {}),
      ...(err.status !== undefined ? { status: err.status } : {}),
      ...(err.message ? { message: err.message } : {}),
    });
  }

  const transcript = builder.finish();
  transcript.requests = transcript.requests.filter((request) => reconstructed.billed.has(request.messageId));
  if (reconstructed.unbilledOutput) transcript.meta.usageIncomplete = true;
  if (transcript.requests.length === 0 && reconstructed.recordedModels.size > 0) {
    transcript.meta.recordedModels = [...reconstructed.recordedModels].sort();
  }

  const billedSeqs = new Set(transcript.requests.map((request) => request.seq));
  for (const message of transcript.messages) {
    if (message.requestSeq !== undefined && !billedSeqs.has(message.requestSeq)) delete message.requestSeq;
  }
  for (const call of transcript.toolCalls) {
    if (!billedSeqs.has(call.requestSeq)) call.requestSeq = -1;
    const spawn = reconstructed.subagentSpawns.get(call.toolUseId);
    if (spawn) {
      if (spawn.agentId) call.childAgentId = spawn.agentId;
      if (spawn.description) call.childDescription = spawn.description;
      if (spawn.model) call.childModel = spawn.model;
      if (spawn.agentId && agentMetaOut) {
        const meta = agentMetaOut[spawn.agentId] ?? {};
        meta.toolUseId = call.toolUseId;
        if (spawn.agentType) meta.agentType = spawn.agentType;
        if (spawn.description) meta.description = spawn.description;
        if (spawn.model) meta.model = spawn.model;
        if (agentId) meta.parentAgentId = agentId;
        agentMetaOut[spawn.agentId] = meta;
      }
    }
  }

  return transcript;
}

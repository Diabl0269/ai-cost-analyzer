/** VS Code's persisted chat snapshots and object-mutation journals (versions 1–3).
 * Format: microsoft/vscode src/vs/workbench/contrib/chat/common/model/{chatModel,objectMutationLog}.ts.
 * These are visible chat turns, not an API billing ledger: context counters are not billed usage.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from '../parse/transcript.js';
import { asRecord, list, parseJson, rec, str } from '../parse/raw.js';
import type { DiscoveredFile, DiscoveredSession, ParsedTranscript } from '../types.js';
import type { DiscoveryWarning } from '../discover.js';
type Raw = Record<string, unknown>;
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);

/** Replay the upstream Initial/Set/Push/Delete operations without following prototype paths. */
export function replayVscodeCopilotJournal(source: string): Raw {
  let state: Raw | undefined;
  for (const text of source.split(/\r?\n/)) {
    if (!text.trim()) continue;
    const entry = asRecord(parseJson(text));
    if (!entry) throw new Error('Invalid VS Code chat journal entry');
    if (entry['kind'] === 0) { state = asRecord(entry['v']); continue; }
    if (!state) throw new Error('VS Code chat journal has no initial snapshot');
    const keys = entry['k'];
    if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'string' && typeof key !== 'number' || unsafe.has(String(key)))) throw new Error('Invalid VS Code chat journal path');
    let target: Raw | unknown[] = state;
    for (const key of keys.slice(0, -1)) {
      const next: unknown = (target as Raw)[String(key)];
      if (!next || typeof next !== 'object') throw new Error('Invalid VS Code chat journal target');
      target = next as Raw | unknown[];
    }
    const key = String(keys.at(-1));
    const object = target as Raw;
    if (entry['kind'] === 1) object[key] = entry['v'];
    else if (entry['kind'] === 3) delete object[key];
    else if (entry['kind'] === 2) {
      const array = object[key] ?? [];
      if (!Array.isArray(array)) throw new Error('Invalid VS Code chat journal array');
      const index = entry['i'];
      if (index !== undefined) {
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > array.length) throw new Error('Invalid VS Code chat journal splice');
        array.length = index;
      }
      if (entry['v'] !== undefined && !Array.isArray(entry['v'])) throw new Error('Invalid VS Code chat journal push');
      for (const value of (entry['v'] as unknown[] | undefined) ?? []) array.push(value);
      object[key] = array;
    } else throw new Error('Unknown VS Code chat journal operation');
  }
  if (!state || !Array.isArray(state['requests'])) throw new Error('Invalid VS Code chat snapshot');
  return state;
}

export async function readVscodeCopilotSession(filePath: string): Promise<Raw> {
  const source = await readFile(filePath, 'utf8');
  if (filePath.endsWith('.jsonl')) return replayVscodeCopilotJournal(source);
  const state = asRecord(parseJson(source));
  if (!state || !Array.isArray(state['requests'])) throw new Error('Invalid VS Code chat snapshot');
  return state;
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const raw = asRecord(value);
  return str(raw, 'value') ?? str(raw, 'text') ?? '';
}
function modelOf(request: Raw): string {
  return str(rec(rec(request, 'result'), 'metadata'), 'resolvedModel') ?? str(request, 'modelId') ?? '';
}
function normalize(state: Raw): Raw[] {
  const lines: Raw[] = [];
  for (const [index, value] of list(state, 'requests').entries()) {
    const request = asRecord(value);
    if (!request || request['hiddenFromTranscript'] === true) continue;
    const ts = timestamp(request['timestamp'] ?? state['creationDate']);
    const id = str(request, 'requestId') ?? `turn-${index}`;
    if (request['requestHiddenFromTranscript'] !== true) lines.push({ type: 'user', uuid: `${id}-prompt`, timestamp: ts, isMeta: request['isSystemInitiated'] === true, message: { content: textOf(request['message']) } });
    const model = modelOf(request);
    let partIndex = 0;
    const response = Array.isArray(request['response']) ? request['response'] : request['response'] ? [request['response']] : [];
    for (const value of response) {
      const part = asRecord(value);
      if (!part) continue;
      const kind = str(part, 'kind');
      const content: Raw[] = [];
      if (kind === 'toolInvocationSerialized' || kind === 'toolInvocation') {
        const specific = rec(part, 'toolSpecificData');
        const command = str(rec(specific, 'commandLine'), 'original') ?? textOf(specific?.['commandLine']);
        const toolId = str(part, 'toolCallId') ?? str(part, 'invocationId') ?? `${id}-tool-${partIndex}`;
        content.push({ type: 'tool_use', id: toolId, name: str(part, 'toolId') ?? 'unknown', input: part['parameters'] ?? (command ? { command } : { description: textOf(part['invocationMessage']) }) });
        lines.push({ type: 'assistant', timestamp: ts, message: { id: `${id}-part-${partIndex++}`, model, content } });
        if (part['isComplete'] === true || kind === 'toolInvocationSerialized') lines.push({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: textOf(part['pastTenseMessage']) || textOf(part['resultDetails']) }] } });
        continue;
      }
      if (kind === 'thinking') content.push({ type: 'thinking', thinking: Array.isArray(part['value']) ? part['value'].filter(value => typeof value === 'string').join('') : textOf(part['value']) || textOf(part['text']) });
      else {
        const text = kind === 'markdownContent' ? textOf(part['content']) : textOf(part);
        if (text) content.push({ type: 'text', text });
      }
      if (content.length) lines.push({ type: 'assistant', timestamp: timestamp(request['responseTimestamp']) ?? ts, message: { id: `${id}-part-${partIndex++}`, model, content } });
    }
    // Retain the requested model for empty/interrupted responses too.
    if (partIndex === 0 && model) lines.push({ type: 'assistant', timestamp: ts, message: { id, model, content: [] } });
  }
  return lines;
}
/** Virtual seq is its array index; byte ranges cannot address reconstructed journal messages. */
export async function readVscodeCopilotLines(filePath: string): Promise<Raw[]> { return normalize(await readVscodeCopilotSession(filePath)); }

export async function parseVscodeCopilotTranscript(file: DiscoveredFile, agentId: string | null = null): Promise<ParsedTranscript> {
  const state = await readVscodeCopilotSession(file.path);
  const lines = normalize(state);
  const builder = new Builder(file, agentId, agentId === null);
  builder.meta.entrypoint = 'vscode-copilot';
  const cwd = await workingDirectoryOf(state, file.path);
  if (cwd) builder.meta.cwd = cwd;
  const title = str(state, 'customTitle') ?? str(state, 'computedTitle');
  if (title) builder.facts.customTitle = title;
  builder.meta.lineCount = lines.length;
  for (const [seq, line] of lines.entries()) builder.take(line, seq, { byteOffset: 0, byteLength: 0 });
  const transcript = builder.finish();
  if (transcript.requests.length) transcript.meta.usageIncomplete = true;
  transcript.meta.recordedModels = [...new Set(transcript.requests.map(request => request.model).filter(Boolean))];
  transcript.requests = [];
  for (const message of transcript.messages) delete message.requestSeq;
  for (const call of transcript.toolCalls) call.requestSeq = -1;
  return transcript;
}
function directoryOf(state: Raw): string | undefined {
  const value = str(state, 'workingDirectory');
  if (!value) return undefined;
  if (value.startsWith('file:')) { try { return fileURLToPath(value); } catch { return undefined; } }
  return path.isAbsolute(value) ? value : undefined;
}

async function workingDirectoryOf(state: Raw, filePath: string): Promise<string | undefined> {
  const cwd = directoryOf(state);
  if (cwd || path.basename(path.dirname(filePath)) !== 'chatSessions') return cwd;
  // workspace.json contains workspace URIs, never extension settings or credentials.
  const metadata = asRecord(parseJson(await readFile(path.join(path.dirname(filePath), '..', 'workspace.json'), 'utf8').catch(() => '')));
  return directoryOf({ workingDirectory: str(metadata, 'folder') });
}

/** Walk only known chat storage layouts; never traverse extension settings/authentication files. */
export class VscodeCopilotScan {
  readonly warnings: DiscoveryWarning[] = [];
  private readonly sessions = new Map<string, DiscoveredSession>();
  private readonly seen = new Set<string>();
  async scan(root: string): Promise<void> {
    try {
      const canonical = await realpath(root);
      if (this.seen.has(canonical)) return;
      this.seen.add(canonical);
      const entries = await readdir(root, { withFileTypes: true });
      const basename = path.basename(root);
      if (basename === 'chatSessions' || basename === 'emptyWindowChatSessions') {
        const names = new Set(entries.map((entry) => entry.name));
        for (const entry of entries) {
          if (!entry.isFile() || !/\.jsonl?$/.test(entry.name)) continue;
          if (entry.name.endsWith('.json') && names.has(entry.name.replace(/\.json$/, '.jsonl'))) continue;
          await this.file(path.join(root, entry.name));
        }
      } else {
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (['User', 'workspaceStorage', 'globalStorage', 'chatSessions', 'emptyWindowChatSessions'].includes(entry.name) || basename === 'workspaceStorage') await this.scan(path.join(root, entry.name));
        }
      }
    } catch { this.warnings.push({ path: root, message: 'VS Code chat directory is unreadable' }); }
  }
  finish(): DiscoveredSession[] { return [...this.sessions.values()]; }
  private async file(filePath: string): Promise<void> {
    try {
      const state = await readVscodeCopilotSession(filePath);
      // VS Code also stores non-Copilot providers. Include only explicit GitHub agents/models.
      if (!list(state, 'requests').some((value) => {
        const request = asRecord(value);
        const agent = rec(request, 'agent');
        const extension = agent?.['extensionId'];
        const extensionId = typeof extension === 'string' ? extension : str(asRecord(extension), 'value');
        return extensionId?.toLowerCase() === 'github.copilot-chat' || str(request, 'modelId')?.startsWith('copilot/');
      })) return;
      const id = str(state, 'sessionId') ?? path.basename(filePath).replace(/\.jsonl?$/, '');
      const sessionId = `copilot-vscode-${id}`;
      const cwd = await workingDirectoryOf(state, filePath);
      const projectDirName = cwd ? `copilot-project-${Buffer.from(cwd).toString('base64url')}` : `copilot-vscode-unknown-${id}`;
      const info = await stat(filePath);
      const session: DiscoveredSession = { provider: 'copilot', projectDirName, projectDirPath: cwd ?? path.dirname(filePath), sessionId,
        mainFile: { provider: 'copilot', path: filePath, size: info.size, mtimeMs: info.mtimeMs, kind: 'main', projectDirName, sessionId }, agentFiles: [], workflowRuns: [] };
      const previous = this.sessions.get(sessionId);
      if (!previous || info.mtimeMs > previous.mainFile.mtimeMs) this.sessions.set(sessionId, session);
    } catch { this.warnings.push({ path: filePath, message: 'VS Code chat snapshot is unreadable' }); }
  }
}
export async function isVscodeCopilotRoot(root: string): Promise<boolean> {
  if (['workspaceStorage', 'globalStorage', 'chatSessions', 'emptyWindowChatSessions'].includes(path.basename(root))) return true;
  try { const entries = await readdir(root); return entries.includes('workspaceStorage') || entries.includes('emptyWindowChatSessions') || entries.includes('chatSessions'); } catch { return false; }
}

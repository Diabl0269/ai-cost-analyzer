/**
 * One `DiscoveredSession` → one `ParsedSession`: the main transcript, its subagents, its workflow
 * runs, and the side files (`agent-*.meta.json`, `journal.jsonl`, `custom-title.json`).
 */
import { parseVscodeCopilotTranscript } from '../copilot/vscode.js';
import { parseCopilotTranscript } from '../copilot/transcript.js';
import { parseCodexTranscript } from '../codex/transcript.js';
import { readFile } from 'node:fs/promises';
import { readJsonlLines } from '../jsonl.js';
import type {
  AgentMeta,
  DiscoveredFile,
  DiscoveredSession,
  ParsedSession,
  ParsedTranscript,
  ParsedWorkflowRun,
} from '../types.js';
import { asRecord, num, parseJson, str } from './raw.js';
import { parseTranscript } from './transcript.js';

export async function parseSession(d: DiscoveredSession): Promise<ParsedSession> {
  const parse = d.mainFile.sessionId.startsWith('copilot-vscode-')
    ? (file: DiscoveredFile, opts: { agentId: string | null }) => parseVscodeCopilotTranscript(file, opts.agentId)
    : d.provider === 'copilot' || d.mainFile.provider === 'copilot'
    ? (file: DiscoveredFile, opts: { agentId: string | null }) => parseCopilotTranscript(file, opts.agentId)
    : d.provider === 'codex' || d.mainFile.provider === 'codex'
    ? (file: DiscoveredFile, opts: { agentId: string | null }) => parseCodexTranscript(file, opts.agentId)
    : parseTranscript;
  const main = await parse(d.mainFile, { agentId: null });
  if (d.mainFile.sessionId.startsWith('copilot-vscode-') && !main.meta.cwd && d.projectDirName.startsWith('copilot-project-')) main.meta.cwd = d.projectDirPath;

  const agents: ParsedTranscript[] = [];
  const agentMeta: Record<string, AgentMeta> = {};
  for (const file of d.agentFiles) {
    agents.push(await parse(file, { agentId: file.agentId ?? null }));
    await loadMeta(file, agentMeta);
  }

  const workflowRuns: ParsedWorkflowRun[] = [];
  for (const run of d.workflowRuns) {
    const runAgents: ParsedTranscript[] = [];
    for (const file of run.agentFiles) {
      runAgents.push(await parse(file, { agentId: file.agentId ?? null }));
      await loadMeta(file, agentMeta);
    }
    workflowRuns.push({
      runId: run.runId,
      dir: run.dir,
      agents: runAgents,
      journal: await readJournal(run.journalPath),
    });
  }

  // Legacy sidechains live inside the main file; expose them as agents so callers that iterate
  // `agents` see every sub-transcript exactly once (`main.embeddedAgents` holds the same objects).
  for (const transcript of Object.values(main.embeddedAgents ?? {})) agents.push(transcript);

  const session: ParsedSession = { discovered: d, main, agents, agentMeta, workflowRuns };
  const customTitle = await readCustomTitle(d.customTitlePath);
  if (customTitle) session.customTitleFromFile = customTitle;
  return session;
}

async function loadMeta(file: DiscoveredFile, into: Record<string, AgentMeta>): Promise<void> {
  if (!file.metaPath || !file.agentId) return;
  const raw = asRecord(parseJson(await readTextOrEmpty(file.metaPath)));
  if (!raw) return;
  const meta: AgentMeta = {};
  const agentType = str(raw, 'agentType');
  const description = str(raw, 'description');
  const toolUseId = str(raw, 'toolUseId');
  const parentAgentId = str(raw, 'parentAgentId');
  const spawnDepth = num(raw, 'spawnDepth');
  const model = str(raw, 'model');
  if (agentType) meta.agentType = agentType;
  if (description) meta.description = description;
  if (toolUseId) meta.toolUseId = toolUseId;
  if (parentAgentId) meta.parentAgentId = parentAgentId;
  if (spawnDepth !== undefined) meta.spawnDepth = spawnDepth;
  if (model) meta.model = model;
  into[file.agentId] = meta;
}

async function readJournal(journalPath: string | undefined): Promise<ParsedWorkflowRun['journal']> {
  const journal = { started: 0, result: 0, failed: 0 };
  if (!journalPath) return journal;
  try {
    for await (const line of readJsonlLines(journalPath)) {
      if (line.text.trim() === '') continue;
      const type = str(asRecord(parseJson(line.text)), 'type');
      if (type === 'started') journal.started += 1;
      else if (type === 'result') journal.result += 1;
      else if (type === 'failed') journal.failed += 1;
    }
  } catch {
    // A missing or truncated journal only costs us the counts.
  }
  return journal;
}

async function readCustomTitle(customTitlePath: string | undefined): Promise<string | undefined> {
  if (!customTitlePath) return undefined;
  const raw = asRecord(parseJson(await readTextOrEmpty(customTitlePath)));
  return str(raw, 'customTitle');
}

async function readTextOrEmpty(p: string): Promise<string> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return '';
  }
}

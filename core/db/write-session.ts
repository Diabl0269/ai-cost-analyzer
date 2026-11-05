/**
 * Writes one parsed session into the index. Every statement is prepared once per indexer run and
 * every session is written inside a single transaction (see indexer.ts), so a crash mid-run leaves
 * previously indexed sessions intact and the interrupted session untouched.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  AttributedItem,
  ContextItemKind,
  DiscoveredFile,
  TokenUsage,
  ParsedSession,
  ParsedTranscript,
  PricingConfig,
  TranscriptAttribution,
} from '../types.js';
import { attributeTranscript } from '../cost/attribution.js';
import { localDateKey } from '../cost/plan.js';
import { bind } from './rows.js';
import { resolveFirstPrompt, resolveSessionTitle } from './title.js';

/** Main transcript rows use the empty string as their agent id so the PK stays NOT NULL. */
export const MAIN_AGENT = '';

/** Attributed items that go to `context_items` rather than to a tool call or an injection. */
const CONTEXT_ITEM_KINDS = new Set<string>([
  'assistant_history',
  'baseline',
  'post_compaction_floor',
] satisfies ContextItemKind[]);

function localDateOf(ts: string | undefined, fallback = ''): string {
  if (!ts) return fallback;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fallback : localDateKey(d);
}

interface TranscriptSlot {
  transcript: ParsedTranscript;
  agentId: string;
  runId: string | null;
}

function collectTranscripts(session: ParsedSession): TranscriptSlot[] {
  const slots: TranscriptSlot[] = [{ transcript: session.main, agentId: MAIN_AGENT, runId: null }];
  for (const agent of session.agents) {
    slots.push({ transcript: agent, agentId: agent.agentId ?? agent.file.agentId ?? '', runId: null });
  }
  for (const run of session.workflowRuns) {
    for (const agent of run.agents) {
      slots.push({ transcript: agent, agentId: agent.agentId ?? agent.file.agentId ?? '', runId: run.runId });
    }
  }
  for (const [agentId, transcript] of Object.entries(session.main.embeddedAgents ?? {})) {
    slots.push({ transcript, agentId, runId: null });
  }
  return slots.filter((slot) => slot.agentId !== MAIN_AGENT || slot.transcript === session.main);
}

function discoveredFilesOf(session: ParsedSession): DiscoveredFile[] {
  const files: DiscoveredFile[] = [session.discovered.mainFile, ...session.discovered.agentFiles];
  for (const run of session.discovered.workflowRuns) files.push(...run.agentFiles);
  return files;
}

/** Longest agent label the UI has room for; `AgentNode.description` is a single table cell. */
export const AGENT_DESCRIPTION_CHARS = 80;

/**
 * Label for an agent row. `meta.json` carries a `description` for `Agent` tool calls but not for
 * workflow agents, whose rows would otherwise read as the bare `agentType` ("workflow-subagent").
 * The agent's own first human prompt — already cleaned of harness wrappers by the parser — says
 * what it was asked to do, so it stands in, truncated to one line's worth.
 */
export function agentDescription(
  description: string | undefined,
  transcript: ParsedTranscript,
): string | undefined {
  const explicit = description?.trim();
  if (explicit) return explicit;
  const prompt = transcript.meta.firstPrompt?.trim();
  return prompt ? prompt.slice(0, AGENT_DESCRIPTION_CHARS).trim() : undefined;
}

/** `path\tsize\tmtimeMs` per file, sorted — the incremental-index comparison key. */
export function fileSignature(files: readonly { path: string; size: number; mtimeMs: number }[]): string {
  return [...files]
    .map((f) => `${f.path}\t${f.size}\t${f.mtimeMs}`)
    .sort()
    .join('\n');
}

export class SessionWriter {
  private readonly statements: Record<string, StatementSync>;

  constructor(private readonly db: DatabaseSync) {
    this.statements = {
      deleteMessagesFts: db.prepare(
        'DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE sessionId = ?)',
      ),
      deleteSessionsFts: db.prepare('DELETE FROM sessions_fts WHERE sessionId = ?'),
      deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
      deleteFiles: db.prepare('DELETE FROM files WHERE sessionId = ?'),
      insertSession: db.prepare(`INSERT INTO sessions (
        id, projectId, cwd, title, titleSource, firstPrompt, startedAt, endedAt, startedDate,
        durationMs, activeMs, entrypoint, sessionKind, gitBranch, version, effort,
        promptCount, requestCount, toolCallCount, agentCount, workflowRunCount, compactionCount,
        apiErrorCount, hookRunCount, reportedCostUsd, reportedJson, continuedInSessionId, permissionMode,
        prLinksJson, localCommandsJson, turnDurationsJson, modelsJson, filePath, lineCount, provider, usageIncomplete
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertSessionFts: db.prepare(
        'INSERT INTO sessions_fts (title, firstPrompt, projectPath, sessionId) VALUES (?,?,?,?)',
      ),
      insertProject: db.prepare(
        `INSERT INTO projects (id, dirName, path, displayName, parentPath, isWorktree, isScratch)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      ),
      insertFile: db.prepare(
        `INSERT INTO files (path, size, mtimeMs, kind, sessionId, agentId, runId, projectDirName, indexedAt)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtimeMs = excluded.mtimeMs,
           kind = excluded.kind, sessionId = excluded.sessionId, agentId = excluded.agentId,
           runId = excluded.runId, projectDirName = excluded.projectDirName, indexedAt = excluded.indexedAt`,
      ),
      selectFileId: db.prepare('SELECT id FROM files WHERE path = ?'),
      insertAgent: db.prepare(`INSERT INTO agents (
        sessionId, agentId, runId, parentAgentId, parentToolUseId, agentType, description,
        requestedModel, spawnDepth, startedAt, endedAt, requestCount, toolCallCount, filePath
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertWorkflowRun: db.prepare(
        `INSERT INTO workflow_runs (sessionId, runId, toolUseId, agentCount, journalStarted, journalResult, journalFailed)
         VALUES (?,?,?,?,?,?,?)`,
      ),
      insertRequest: db.prepare(`INSERT INTO requests (
        sessionId, agentId, seq, iterIndex, turnIndex, ts, dateLocal, model, speed, serviceTier, inferenceGeo,
        input, output, cacheRead, cache5m, cache1h, cacheAssumed, thinking, webSearchRequests,
        webFetchRequests, contextTokens, stopReason, isFallback, effort, skill, plugin, mcpServer,
        mcpTool, messageId, iterationsJson, toolNamesJson
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertToolCall: db.prepare(`INSERT INTO tool_calls (
        sessionId, agentId, toolUseId, name, mcpServer, mcpTool, requestSeq, turnIndex, ts, dateLocal,
        inputChars, inputSummary, resultSeq, resultChars, resultImages, resultShape, isError, resultPreview,
        childAgentId, childRunId, childModel, childDescription, durationMs,
        genTokens, tokens, estMethod, ingestRequestSeq, lastCarrySeq
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertContextItem: db.prepare(`INSERT INTO context_items (
        sessionId, agentId, seq, turnIndex, dateLocal, kind, tokens, estMethod, ingestRequestSeq, lastCarrySeq
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`),
      insertInjection: db.prepare(`INSERT INTO injections (
        sessionId, agentId, seq, turnIndex, ts, dateLocal, kind, name, chars, charsSource,
        hookName, hookEvent, tokens, estMethod, ingestRequestSeq, lastCarrySeq
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertHookRun: db.prepare(`INSERT INTO hook_runs (
        sessionId, agentId, seq, turnIndex, ts, dateLocal, kind, hookName, hookEvent, command,
        durationMs, exitCode, timedOut, hookCount, errorCount, injectedChars
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertCompaction: db.prepare(
        `INSERT INTO compactions (sessionId, agentId, seq, turnIndex, ts, dateLocal, trigger, preTokens, postTokens, durationMs)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ),
      insertApiError: db.prepare(
        'INSERT INTO api_errors (sessionId, agentId, seq, ts, status, message) VALUES (?,?,?,?,?,?)',
      ),
      insertMessage: db.prepare(`INSERT INTO messages (
        sessionId, agentId, seq, turnIndex, uuid, parentUuid, ts, dateLocal, role, kind, subtype,
        messageId, requestSeq, model, toolNames, fileId, byteOffset, byteLength, preview, isMeta, isSidechain
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertMessageFts: db.prepare('INSERT INTO messages_fts (rowid, text, messageRowid) VALUES (?,?,?)'),
    };
  }

  /** Removes every row belonging to a session, FTS included. */
  deleteSession(sessionId: string): void {
    this.statements['deleteMessagesFts']?.run(sessionId);
    this.statements['deleteSessionsFts']?.run(sessionId);
    this.statements['deleteFiles']?.run(sessionId);
    this.statements['deleteSession']?.run(sessionId);
  }

  write(session: ParsedSession, pricing: PricingConfig): void {
    const sessionId = session.discovered.sessionId;
    this.deleteSession(sessionId);

    const cwd = session.main.meta.cwd ?? '';
    let projectId = session.discovered.projectDirName;
    // Claude's directory encoding is lossy too. Preserve familiar IDs unless that ID already
    // belongs to another exact folder, then use a reversible path key instead of merging them.
    if (cwd) {
      const collision = this.db.prepare('SELECT 1 FROM sessions WHERE projectId = ? AND cwd != ? LIMIT 1').get(projectId, cwd);
      if (collision) projectId = `folder-${Buffer.from(cwd).toString('base64url')}`;
    }
    this.statements['insertProject']?.run(
      projectId,
      projectId,
      cwd || projectId,
      cwd || projectId,
      null,
      0,
      0,
    );

    const slots = collectTranscripts(session);
    const title = resolveSessionTitle(session);
    const firstPrompt = resolveFirstPrompt(session);
    const facts = session.main.facts;

    let startedAt = session.main.meta.firstTs ?? '';
    let endedAt = session.main.meta.lastTs ?? '';
    let requestCount = 0;
    let toolCallCount = 0;
    let compactionCount = 0;
    let apiErrorCount = 0;
    let hookRunCount = 0;
    const models = new Set<string>();
    for (const slot of slots) {
      const meta = slot.transcript.meta;
      if (meta.firstTs && (!startedAt || meta.firstTs < startedAt)) startedAt = meta.firstTs;
      if (meta.lastTs && (!endedAt || meta.lastTs > endedAt)) endedAt = meta.lastTs;
      for (const req of slot.transcript.requests) {
        if (req.isSynthetic) continue;
        requestCount += 1;
        models.add(req.model);
      }
      toolCallCount += slot.transcript.toolCalls.length;
      compactionCount += slot.transcript.compactions.length;
      apiErrorCount += slot.transcript.apiErrors.length;
      hookRunCount += slot.transcript.hooks.length;
    }
    const turnDurations = facts?.turnDurationsMs ?? [];
    const durationMs =
      startedAt && endedAt ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()) : 0;
    const activeMs = turnDurations.reduce((sum, d) => sum + d, 0);
    const workflowRunCount = session.workflowRuns.length;
    const agentCount = slots.length - 1;

    this.statements['insertSession']?.run(
      sessionId,
      projectId,
      bind(cwd || null),
      title.title,
      title.source,
      firstPrompt,
      startedAt,
      endedAt,
      localDateOf(startedAt),
      durationMs,
      activeMs,
      bind(session.main.meta.entrypoint),
      bind(session.main.meta.sessionKind),
      bind(session.main.meta.gitBranch),
      bind(session.main.meta.version),
      bind(session.main.meta.effort),
      session.main.promptCount,
      requestCount,
      toolCallCount,
      agentCount,
      workflowRunCount,
      compactionCount,
      apiErrorCount,
      hookRunCount,
      bind(facts?.reportedCost?.totalCostUSD ?? null),
      facts?.reportedCost ? JSON.stringify(facts.reportedCost) : null,
      bind(facts?.continuedInSessionId),
      bind(facts?.permissionMode),
      JSON.stringify(facts?.prLinks ?? []),
      JSON.stringify(facts?.localCommands ?? []),
      JSON.stringify(turnDurations),
      JSON.stringify([...models]),
      session.discovered.mainFile.path,
      session.main.meta.lineCount,
      session.discovered.provider ?? 'claude',
      slots.some(slot => slot.transcript.meta.usageIncomplete) ? 1 : 0,
    );
    this.statements['insertSessionFts']?.run(title.title, firstPrompt, cwd || projectId, sessionId);

    const now = new Date().toISOString();
    const fileIds = new Map<string, number>();
    for (const file of discoveredFilesOf(session)) {
      this.statements['insertFile']?.run(
        file.path,
        file.size,
        file.mtimeMs,
        file.kind,
        sessionId,
        file.agentId ?? MAIN_AGENT,
        bind(file.runId),
        file.projectDirName,
        now,
      );
      const row = this.statements['selectFileId']?.get(file.path);
      const id = row?.['id'];
      if (typeof id === 'number') fileIds.set(file.path, id);
    }

    for (const run of session.workflowRuns) {
      const toolUseId = session.main.toolCalls.find((c) => c.childRunId === run.runId)?.toolUseId;
      this.statements['insertWorkflowRun']?.run(
        sessionId,
        run.runId,
        bind(toolUseId),
        run.agents.length,
        run.journal.started,
        run.journal.result,
        run.journal.failed,
      );
    }

    const sessionDate = localDateOf(startedAt);
    for (const slot of slots) {
      this.writeTranscript(sessionId, slot, session, pricing, fileIds, sessionDate);
    }
  }

  private writeTranscript(
    sessionId: string,
    slot: TranscriptSlot,
    session: ParsedSession,
    pricing: PricingConfig,
    fileIds: ReadonlyMap<string, number>,
    sessionDate: string,
  ): void {
    const { transcript: t, agentId } = slot;
    const attribution = attributeTranscript(t, pricing);
    const toolFacts = new Map<string, AttributedItem>();
    const contextFacts: AttributedItem[] = [];
    // A single line can carry several injections (a stop-hook summary, a multi-part attachment), so
    // facts are matched to injections positionally within a seq rather than by seq alone.
    const injectionFacts = new Map<number, AttributedItem[]>();
    for (const item of attribution.items) {
      if (CONTEXT_ITEM_KINDS.has(item.kind)) {
        contextFacts.push(item);
      } else if (item.kind === 'tool_result' && typeof item.ref === 'string') {
        toolFacts.set(item.ref, item);
      } else if (typeof item.ref === 'number') {
        const list = injectionFacts.get(item.ref);
        if (list) list.push(item);
        else injectionFacts.set(item.ref, [item]);
      }
    }
    const injectionCursor = new Map<number, number>();

    if (agentId !== MAIN_AGENT) {
      const meta = session.agentMeta[agentId] ?? {};
      this.statements['insertAgent']?.run(
        sessionId,
        agentId,
        bind(slot.runId),
        bind(meta.parentAgentId),
        bind(meta.toolUseId),
        bind(meta.agentType),
        bind(agentDescription(meta.description, t)),
        bind(meta.model),
        meta.spawnDepth ?? (slot.runId ? 1 : 0),
        bind(t.meta.firstTs),
        bind(t.meta.lastTs),
        t.requests.filter((r) => !r.isSynthetic).length,
        t.toolCalls.length,
        t.file.path,
      );
    }

    const requestModels = new Map<number, string>();
    const insertRequest = this.statements['insertRequest'];
    for (const req of t.requests) {
      requestModels.set(req.seq, req.model);
      if (req.isSynthetic || !insertRequest) continue;
      const dateLocal = localDateOf(req.ts);
      const toolNamesJson = JSON.stringify(req.blocks.filter((b) => b.toolName).map((b) => b.toolName));
      // iterIndex 0 carries the canonical request (top-level usage == the last iteration, SPEC §3.3);
      // any earlier iteration is written as an extra billed unit so aggregates bill each one at its
      // own model without double counting context.
      const billed: { model: string; usage: TokenUsage; context: number }[] = [
        { model: req.model, usage: req.usage, context: req.contextTokens },
      ];
      if (req.iterations && req.iterations.length > 1) {
        for (const iteration of req.iterations.slice(0, -1)) {
          billed.push({ model: iteration.model || req.model, usage: iteration.usage, context: 0 });
        }
      }
      billed.forEach((unit, iterIndex) => {
        insertRequest.run(
          sessionId,
          agentId,
          req.seq,
          iterIndex,
          req.turnIndex,
          req.ts,
          dateLocal,
          unit.model,
          req.speed,
          req.serviceTier,
          req.inferenceGeo,
          unit.usage.input,
          unit.usage.output,
          unit.usage.cacheRead,
          // An assumed TTL is stored apart from the reported split so read-time pricing can put
          // it in whichever bucket `assumeCacheWriteTtlWhenUnknown` names, without a reindex.
          unit.usage.assumedTtl ? 0 : unit.usage.cache5m,
          unit.usage.assumedTtl ? 0 : unit.usage.cache1h,
          unit.usage.assumedTtl ? unit.usage.cache5m + unit.usage.cache1h : 0,
          unit.usage.thinking,
          unit.usage.webSearchRequests,
          unit.usage.webFetchRequests,
          unit.context,
          bind(req.stopReason),
          bind(req.isFallback),
          bind(req.effort),
          bind(req.attribution.skill),
          bind(req.attribution.plugin),
          bind(req.attribution.mcpServer),
          bind(req.attribution.mcpTool),
          bind(req.messageId),
          iterIndex === 0 && req.iterations && req.iterations.length > 1
            ? JSON.stringify(req.iterations)
            : null,
          toolNamesJson,
        );
      });
    }

    const toolNamesBySeq = new Map<number, Set<string>>();
    const addToolName = (seq: number | undefined, name: string): void => {
      if (seq === undefined) return;
      const set = toolNamesBySeq.get(seq) ?? new Set<string>();
      set.add(name);
      toolNamesBySeq.set(seq, set);
    };

    for (const call of t.toolCalls) {
      addToolName(call.requestSeq, call.name);
      addToolName(call.resultSeq, call.name);
      const fact = toolFacts.get(call.toolUseId);
      const genTokens = attribution.outputShares.get(call.requestSeq)?.toolUseTokens.get(call.toolUseId) ?? 0;
      this.statements['insertToolCall']?.run(
        sessionId,
        agentId,
        call.toolUseId,
        call.name,
        bind(call.mcpServer),
        bind(call.mcpTool),
        call.requestSeq,
        call.turnIndex,
        call.ts,
        localDateOf(call.ts, sessionDate),
        call.inputChars,
        call.inputSummary,
        bind(call.resultSeq),
        call.resultChars,
        call.resultImages,
        call.resultShape,
        bind(call.isError),
        call.resultPreview,
        bind(call.childAgentId),
        bind(call.childRunId),
        bind(call.childModel),
        bind(call.childDescription),
        bind(call.durationMs),
        genTokens,
        fact?.tokens ?? 0,
        fact?.estMethod ?? 'none',
        bind(fact?.ingestRequestSeq ?? null),
        bind(fact?.lastCarrySeq ?? null),
      );
    }

    for (const injection of t.injections) {
      const at = injectionCursor.get(injection.seq) ?? 0;
      injectionCursor.set(injection.seq, at + 1);
      const fact = injectionFacts.get(injection.seq)?.[at];
      this.statements['insertInjection']?.run(
        sessionId,
        agentId,
        injection.seq,
        injection.turnIndex,
        bind(injection.ts),
        localDateOf(injection.ts, sessionDate),
        injection.kind,
        injection.name,
        injection.chars,
        injection.charsSource,
        bind(injection.hookName),
        bind(injection.hookEvent),
        fact?.tokens ?? 0,
        fact?.estMethod ?? 'none',
        bind(fact?.ingestRequestSeq ?? null),
        bind(fact?.lastCarrySeq ?? null),
      );
    }

    const tsBySeq = new Map<number, string | undefined>();
    for (const req of t.requests) tsBySeq.set(req.seq, req.ts);
    for (const item of contextFacts) {
      this.statements['insertContextItem']?.run(
        sessionId,
        agentId,
        item.seq,
        item.turnIndex,
        localDateOf(tsBySeq.get(item.seq), sessionDate),
        item.kind,
        item.tokens,
        item.estMethod,
        bind(item.ingestRequestSeq),
        bind(item.lastCarrySeq),
      );
    }

    for (const hook of t.hooks) {
      this.statements['insertHookRun']?.run(
        sessionId,
        agentId,
        hook.seq,
        hook.turnIndex,
        bind(hook.ts),
        localDateOf(hook.ts, sessionDate),
        hook.kind,
        bind(hook.hookName),
        bind(hook.hookEvent),
        bind(hook.command),
        bind(hook.durationMs),
        bind(hook.exitCode),
        bind(hook.timedOut === true),
        bind(hook.hookCount),
        bind(hook.errorCount),
        hook.injectedChars,
      );
    }

    for (const compaction of t.compactions) {
      this.statements['insertCompaction']?.run(
        sessionId,
        agentId,
        compaction.seq,
        compaction.turnIndex,
        bind(compaction.ts),
        localDateOf(compaction.ts, sessionDate),
        bind(compaction.trigger),
        bind(compaction.preTokens),
        bind(compaction.postTokens),
        bind(compaction.durationMs),
      );
    }

    for (const error of t.apiErrors) {
      this.statements['insertApiError']?.run(
        sessionId,
        agentId,
        error.seq,
        bind(error.ts),
        bind(error.status),
        bind(error.message),
      );
    }

    const fileId = fileIds.get(t.file.path) ?? null;
    if (fileId === null) return;
    const insertMessage = this.statements['insertMessage'];
    const insertMessageFts = this.statements['insertMessageFts'];
    if (!insertMessage || !insertMessageFts) return;
    for (const message of t.messages) {
      const toolNames = toolNamesBySeq.get(message.seq);
      const result = insertMessage.run(
        sessionId,
        agentId,
        message.seq,
        message.turnIndex,
        message.uuid,
        bind(message.parentUuid ?? null),
        bind(message.ts),
        localDateOf(message.ts, sessionDate),
        message.role,
        message.kind,
        bind(message.subtype),
        bind(message.messageId),
        bind(message.requestSeq ?? null),
        bind(message.requestSeq !== undefined ? (requestModels.get(message.requestSeq) ?? null) : null),
        toolNames ? [...toolNames].join(' ') : null,
        fileId,
        message.range.byteOffset,
        message.range.byteLength,
        message.preview,
        bind(message.isMeta),
        bind(message.isSidechain),
      );
      if (message.searchText.length > 0) {
        const rowid = Number(result.lastInsertRowid);
        insertMessageFts.run(rowid, message.searchText, rowid);
      }
    }
  }
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { plural } from '@core/pricing/format.js';
import type { CompactionRow, SessionDetail, ToolCallCost, TranscriptMessage, TurnSummary } from '@core/types';
import { Button } from '@/components/Button';
import { Callout } from '@/components/Callout';
import { Duration } from '@/components/Duration';
import { Icon } from '@/components/Icon';
import { Money } from '@/components/Money';
import { Skeleton } from '@/components/Skeleton';
import { Switch } from '@/components/Switch';
import { useTranscript } from '@/lib/queries';
import { useShortcuts } from '@/lib/keyboard';
import { formatCount, formatDate, formatMoney, formatTokensExact } from '@/lib/format';
import { ClampedText, RequestChip, ThinkingBlock, ToolCallRow, ToolResultRow, type ExpandApi } from './blocks';
import { cleanPromptText, commandOnlyPrompt } from './prompt';
import styles from './TranscriptView.module.css';

const PAGE = 150;

type Row =
  | { kind: 'turn'; key: string; turnIndex: number; seq: number }
  | { kind: 'compaction'; key: string; compaction: CompactionRow }
  | { kind: 'message'; key: string; message: TranscriptMessage };

interface Loaded {
  messages: TranscriptMessage[];
  from: number;
  nextForward: number | null;
}

/** Harness plumbing: everything that is context but not conversation. */
function isHarness(message: TranscriptMessage): boolean {
  return message.isMeta || message.role === 'attachment' || message.kind === 'meta' || message.role === 'system';
}

function textOf(message: TranscriptMessage): string {
  return message.blocks
    .map((block) => (block.type === 'text' || block.type === 'thinking' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

export interface TranscriptViewProps {
  sessionId: string;
  agentId: string | null;
  detail: SessionDetail;
  whatIf: string | undefined;
  /** rendered above the toolbar (the agent breadcrumb) */
  heading?: ReactNode;
}

/**
 * The transcript: virtualized, paged in both directions from the JSONL by `seq`, with the
 * price of every request and every tool call attached to the line that caused it.
 */
export function TranscriptView({ sessionId, agentId, detail, whatIf, heading }: TranscriptViewProps) {
  const [params, setParams] = useSearchParams();
  const rawSeq = params.get('seq');
  const targetSeq = rawSeq !== null && /^\d+$/.test(rawSeq) ? Number(rawSeq) : null;

  const [request, setRequest] = useState<{ from: number; limit: number; direction: 'initial' | 'forward' | 'backward' }>(
    () => ({ from: targetSeq === null ? 0 : Math.max(0, targetSeq - 20), limit: PAGE, direction: 'initial' }),
  );
  const [loaded, setLoaded] = useState<Loaded>(() => ({
    messages: [],
    from: targetSeq === null ? 0 : Math.max(0, targetSeq - 20),
    nextForward: null,
  }));
  const [showHarness, setShowHarness] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());

  const page = useTranscript(sessionId, { agentId, fromSeq: request.from, limit: request.limit, whatIf });

  useEffect(() => {
    const data = page.data;
    if (!data) return;
    setLoaded((previous) => {
      const merged = new Map(previous.messages.map((message) => [message.seq, message]));
      for (const message of data.messages) merged.set(message.seq, message);
      const messages = [...merged.values()].sort((a, b) => a.seq - b.seq);
      return {
        messages,
        from: Math.min(previous.from, request.from),
        nextForward: request.direction === 'backward' ? previous.nextForward : data.nextFromSeq,
      };
    });
  }, [page.data, request.from, request.direction]);

  const expand = useMemo<ExpandApi>(
    () => ({
      open,
      toggle: (key: string) =>
        setOpen((previous) => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
    }),
    [open],
  );

  const toolsById = useMemo(() => {
    const map = new Map<string, ToolCallCost>();
    for (const call of detail.toolCalls) map.set(call.toolUseId, call);
    return map;
  }, [detail.toolCalls]);

  const turnsByIndex = useMemo(() => {
    const map = new Map<number, TurnSummary>();
    if (agentId === null) for (const turn of detail.turns) map.set(turn.turnIndex, turn);
    return map;
  }, [detail.turns, agentId]);

  const rows = useMemo<Row[]>(() => {
    const compactions = detail.compactions
      .filter((compaction) => (compaction.agentId ?? null) === agentId)
      .sort((a, b) => a.seq - b.seq);
    const visible = showHarness ? loaded.messages : loaded.messages.filter((message) => !isHarness(message));
    const out: Row[] = [];
    let lastTurn: number | null = null;
    let compactionAt = 0;
    for (const message of visible) {
      for (; compactionAt < compactions.length; compactionAt += 1) {
        const compaction = compactions[compactionAt];
        if (!compaction || compaction.seq > message.seq) break;
        out.push({ kind: 'compaction', key: `c${compaction.seq}`, compaction });
      }
      if (message.turnIndex !== lastTurn) {
        lastTurn = message.turnIndex;
        out.push({ kind: 'turn', key: `t${message.turnIndex}-${message.seq}`, turnIndex: message.turnIndex, seq: message.seq });
      }
      out.push({ kind: 'message', key: `m${message.seq}`, message });
    }
    return out;
  }, [loaded.messages, showHarness, detail.compactions, agentId]);

  const messageCount = useMemo(() => rows.filter((row) => row.kind === 'message').length, [rows]);
  const harnessHidden = useMemo(
    () => (showHarness ? 0 : loaded.messages.filter(isHarness).length),
    [loaded.messages, showHarness],
  );

  /**
   * The turn that cost the most, for the toolbar's jump. Every per-turn cost is already
   * computed server-side, so the priciest one is a lookup rather than a scan of the transcript.
   */
  const priciestTurn = useMemo(() => {
    if (agentId !== null) return null;
    const best = detail.turns.reduce<TurnSummary | null>(
      (top, turn) => (top === null || turn.cost > top.cost ? turn : top),
      null,
    );
    return best && best.cost > 0 && detail.turns.length > 1 ? best : null;
  }, [detail.turns, agentId]);

  /** Fallback per-turn cost, summed from what is loaded: used where the session's own turn
      table has no entry (subagent transcripts, and turns started by a slash command). */
  const loadedTurnStats = useMemo(() => {
    const map = new Map<number, { cost: number; requests: number }>();
    for (const message of loaded.messages) {
      if (!message.request) continue;
      const entry = map.get(message.turnIndex) ?? { cost: 0, requests: 0 };
      entry.cost += message.request.cost.total;
      entry.requests += 1;
      map.set(message.turnIndex, entry);
    }
    return map;
  }, [loaded.messages]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 110,
    overscan: 8,
    // Rows are measured, and a measurement that lands mid-render makes react-virtual call
    // `flushSync` while React is rendering. A frame's delay keeps the two apart.
    useAnimationFrameWithResizeObserver: true,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  /** Scrolls a row into view, and does nothing when it is already there. */
  const scrollToRow = useCallback(
    (index: number, align: 'center' | 'start') => {
      const box = scrollRef.current;
      const target = virtualizer.getOffsetForIndex(index, align)?.[0];
      if (!box || target === undefined) return;
      if (Math.abs(target - box.scrollTop) <= 4) return;
      virtualizer.scrollToIndex(index, { align });
    },
    [virtualizer],
  );

  const jumped = useRef<number | null>(null);
  useEffect(() => {
    if (targetSeq === null || jumped.current === targetSeq || rows.length === 0) return;
    const index = rows.findIndex((row) => row.kind === 'message' && row.message.seq >= targetSeq);
    if (index < 0) return;
    jumped.current = targetSeq;
    // Deferred a frame because `scrollToIndex` calls `flushSync`, which React refuses inside a
    // commit; skipped entirely when the row is already where it should be, because the
    // virtualizer stays in its "scrolling" state until a scroll event that would never come.
    const frame = requestAnimationFrame(() => scrollToRow(index, 'center'));
    return () => cancelAnimationFrame(frame);
  }, [rows, targetSeq, scrollToRow]);

  const turnRowIndexes = useMemo(
    () => rows.map((row, index) => (row.kind === 'turn' ? index : -1)).filter((index) => index >= 0),
    [rows],
  );

  const jumpTurn = useCallback(
    (direction: -1 | 1) => {
      const box = scrollRef.current;
      if (!box) return;
      // The anchor is the row at the top of the *viewport*, resolved from the live scroll offset.
      // `getVirtualItems()[0]` is not: that list starts `overscan` rows above the viewport, so
      // right after a jump it still points above the turn just landed on — `]` found the same
      // turn again and stuck after one press, and `[` never moved at all.
      const anchor = virtualizer.getVirtualItemForOffset(box.scrollTop + 1)?.index ?? 0;
      const target =
        direction === 1
          ? turnRowIndexes.find((index) => index > anchor)
          : [...turnRowIndexes].reverse().find((index) => index < anchor);
      if (target === undefined) return;
      // Deferred for the same reason as the deep-link jump; focus follows a frame later still,
      // because the row only mounts once the virtualizer has scrolled to it. Without the focus
      // move a keyboard reader jumps the viewport but leaves the caret at the top of the page.
      requestAnimationFrame(() => {
        scrollToRow(target, 'start');
        requestAnimationFrame(() => {
          box.querySelector<HTMLElement>(`[data-index="${target}"] [data-turn]`)?.focus({ preventScroll: true });
        });
      });
    },
    [turnRowIndexes, virtualizer, scrollToRow],
  );

  useShortcuts([
    { id: 'transcript-prev-turn', keys: '[', description: 'Previous turn', group: 'Session', run: () => jumpTurn(-1) },
    { id: 'transcript-next-turn', keys: ']', description: 'Next turn', group: 'Session', run: () => jumpTurn(1) },
  ]);

  const clearTarget = useCallback(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('seq');
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [setParams]);

  /**
   * Deep-links to a line the way the URL does on first load. A seq outside the window that is
   * loaded starts a fresh page at that line rather than merging a second island of messages
   * into the list, which would put an unmarked gap in the middle of the transcript.
   */
  const jumpToSeq = useCallback(
    (seq: number) => {
      const from = Math.max(0, seq - 20);
      const inWindow = loaded.messages.some((message) => message.seq >= seq) && loaded.from <= from;
      if (!inWindow) {
        setLoaded({ messages: [], from, nextForward: null });
        setRequest({ from, limit: PAGE, direction: 'initial' });
      }
      jumped.current = null;
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set('seq', String(seq));
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [loaded.messages, loaded.from, setParams],
  );

  const total = page.data?.totalLines ?? 0;
  const earlierCount = Math.min(PAGE, loaded.from);
  const loadEarlier = (): void => {
    const from = Math.max(0, loaded.from - PAGE);
    setRequest({ from, limit: loaded.from - from, direction: 'backward' });
  };
  const loadMore = (): void => {
    if (loaded.nextForward === null) return;
    setRequest({ from: loaded.nextForward, limit: PAGE, direction: 'forward' });
  };

  if (page.isPending && loaded.messages.length === 0) {
    return (
      <div className="stack">
        {heading}
        <Skeleton lines={6} height={14} />
      </div>
    );
  }

  if (page.isError) {
    return (
      <div className="stack">
        {heading}
        <Callout tone="warn" title="This transcript could not be read">
          The JSONL file may have moved since the last index. Re-index from Settings and try again.
        </Callout>
      </div>
    );
  }

  return (
    <div className="stack stack-sm">
      {heading}
      <div className={styles.toolbar}>
        {/* "143 of 1,101 lines" read like truncated data. What is on screen is a number of
            messages; what is missing is either harness plumbing (the switch) or lines not read
            yet (the pager at the end). Both now say so in their own words. */}
        <span className={styles.count}>
          {plural(messageCount, 'message')}
          {loaded.nextForward !== null ? (
            <span className={styles.muted}>
              {' · '}read to line {formatCount(loaded.nextForward)} of {formatCount(total)}
            </span>
          ) : null}
        </span>
        {priciestTurn ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => jumpToSeq(priciestTurn.startSeq)}
            title={`Turn ${priciestTurn.turnIndex} cost ${formatMoney(priciestTurn.cost)} — the most of any turn in this session`}
          >
            Priciest turn · {formatMoney(priciestTurn.cost)}
          </Button>
        ) : null}
        <span className={styles.hint}>
          <kbd>[</kbd> <kbd>]</kbd> jump between turns
        </span>
        <Switch
          checked={showHarness}
          onChange={setShowHarness}
          label="Show harness lines"
          description={
            showHarness
              ? 'System prompts, reminders and attachments are in the list'
              : harnessHidden > 0
                ? `${plural(harnessHidden, 'harness line')} hidden — context, not conversation`
                : 'No harness line among the lines read so far'
          }
          leading
        />
      </div>

      {targetSeq !== null ? (
        <p className={styles.jumpNote}>
          Jumped to line {formatCount(targetSeq)}.{' '}
          <button type="button" className={styles.linkButton} onClick={clearTarget}>
            clear
          </button>
        </p>
      ) : null}

      <div className={styles.scroller} ref={scrollRef}>
        <div className={styles.pager}>
          {loaded.from > 0 ? (
            <Button size="sm" variant="ghost" loading={page.isFetching && request.direction === 'backward'} onClick={loadEarlier}>
              Load the earlier {formatCount(earlierCount)} lines
            </Button>
          ) : (
            <span className={styles.edge}>start of transcript</span>
          )}
        </div>
        <div className={styles.list} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={styles.row}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.kind === 'turn' ? (
                  <TurnHeader
                    turnIndex={row.turnIndex}
                    turn={turnsByIndex.get(row.turnIndex)}
                    fallback={loadedTurnStats.get(row.turnIndex)}
                    isAgent={agentId !== null}
                  />
                ) : row.kind === 'compaction' ? (
                  <CompactionDivider compaction={row.compaction} />
                ) : (
                  <MessageRow
                    message={row.message}
                    toolsById={toolsById}
                    expand={expand}
                    sessionId={sessionId}
                    highlighted={targetSeq === row.message.seq}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className={styles.pager}>
          {loaded.nextForward !== null ? (
            <Button size="sm" variant="ghost" loading={page.isFetching && request.direction === 'forward'} onClick={loadMore}>
              Load the next {formatCount(Math.min(PAGE, Math.max(1, total - (loaded.nextForward ?? total))))} lines
            </Button>
          ) : (
            <span className={styles.edge}>end of transcript</span>
          )}
        </div>
      </div>
    </div>
  );
}

function TurnHeader({
  turnIndex,
  turn,
  fallback,
  isAgent,
}: {
  turnIndex: number;
  turn: TurnSummary | undefined;
  fallback: { cost: number; requests: number } | undefined;
  isAgent: boolean;
}) {
  if (turnIndex === 0 && !turn) {
    return (
      // `tabIndex={-1}` + `data-turn`: not a tab stop, but a place `[` / `]` can put focus so the
      // jump is announced and Tab carries on from the turn the reader landed on.
      <div className={styles.turn} tabIndex={-1} data-turn>
        <span className={styles.turnLabel}>{isAgent ? 'Agent start' : 'Session start'}</span>
        <span className={styles.turnPreview}>
          {isAgent
            ? 'the brief this agent was launched with, and everything loaded around it'
            : 'recorded context before your first prompt'}
        </span>
      </div>
    );
  }
  // The server's preview is the raw first line, tags and all. A turn opened by a slash command
  // showed `<command-name>/model</command-name> <command-message>…` across the header.
  const preview = cleanPromptText(turn?.promptPreview ?? '');
  return (
    <div className={styles.turn} tabIndex={-1} data-turn>
      <span className={styles.turnLabel}>Turn {turnIndex}</span>
      <span className={styles.turnPreview} title={preview}>
        {preview}
      </span>
      <span className={styles.turnStats}>
        {turn ? (
          <>
            {plural(turn.requestCount, 'request')}
            {turn.durationMs ? (
              <>
                {' · '}
                <Duration ms={turn.durationMs} />
              </>
            ) : null}
            {' · '}
            <Money usd={turn.cost} className={styles.turnCost} />
          </>
        ) : fallback ? (
          <span title="Summed from the requests loaded so far">
            {plural(fallback.requests, 'request')} · <Money usd={fallback.cost} className={styles.turnCost} />
          </span>
        ) : null}
      </span>
    </div>
  );
}

function CompactionDivider({ compaction }: { compaction: CompactionRow }) {
  const dropped = Math.max(0, (compaction.preTokens ?? 0) - (compaction.postTokens ?? 0));
  return (
    <div className={styles.compaction}>
      <Icon name="warning" size={13} />
      <span>
        Context compacted ({compaction.trigger ?? 'auto'}) — {formatTokensExact(dropped)} tokens dropped, re-warming cost{' '}
        <Money usd={compaction.rewarmCost} />
      </span>
    </div>
  );
}

function MessageRow({
  message,
  toolsById,
  expand,
  sessionId,
  highlighted,
}: {
  message: TranscriptMessage;
  toolsById: Map<string, ToolCallCost>;
  expand: ExpandApi;
  sessionId: string;
  highlighted: boolean;
}) {
  const thinkingChars = message.blocks.reduce((sum, block) => (block.type === 'thinking' ? sum + block.text.length : sum), 0);
  const thinkingTokens = message.request?.usage.thinking ?? null;

  if (message.role === 'user' && message.kind === 'prompt') {
    const command = commandOnlyPrompt(textOf(message));
    if (command !== null) {
      return (
        <p className={[styles.command, highlighted ? styles.highlight : null].filter(Boolean).join(' ')}>
          <span className={styles.commandLabel}>command</span>
          <span className={styles.commandText}>{command}</span>
          <span className={styles.seq}>#{message.seq}</span>
          {message.ts ? <span className={styles.when}>{formatDate(message.ts, 'time')}</span> : null}
        </p>
      );
    }
    return (
      <article className={[styles.message, styles.prompt, highlighted ? styles.highlight : null].filter(Boolean).join(' ')}>
        <header className={styles.messageHead}>
          <span className={styles.who}>Prompt</span>
          <span className={styles.seq}>#{message.seq}</span>
          {message.ts ? <span className={styles.when}>{formatDate(message.ts, 'time')}</span> : null}
        </header>
        <div className={styles.promptBody}>
          <ClampedText id={`p${message.seq}`} expand={expand} text={cleanPromptText(textOf(message)) || '(empty prompt)'} />
        </div>
      </article>
    );
  }

  if (message.role === 'user' && message.kind === 'compact_summary') {
    return (
      <article className={[styles.message, styles.summaryLine, highlighted ? styles.highlight : null].filter(Boolean).join(' ')}>
        <header className={styles.messageHead}>
          <span className={styles.who}>Compaction summary</span>
          <span className={styles.seq}>#{message.seq}</span>
        </header>
        <ClampedText id={`cs${message.seq}`} expand={expand} text={textOf(message)} />
      </article>
    );
  }

  if (message.role === 'user' && message.kind === 'interrupt') {
    return (
      <p className={[styles.interrupt, highlighted ? styles.highlight : null].filter(Boolean).join(' ')}>
        <Icon name="close" size={12} /> {textOf(message) || 'Interrupted by user'}
      </p>
    );
  }

  if (message.role === 'user' && message.kind === 'tool_result') {
    return (
      <div className={[styles.results, highlighted ? styles.highlight : null].filter(Boolean).join(' ')}>
        {message.blocks.map((block, index) =>
          block.type === 'tool_result' ? (
            <ToolResultRow
              key={`${message.seq}-${index}`}
              id={`r${message.seq}-${index}`}
              toolUseId={block.toolUseId}
              text={block.text}
              images={block.images}
              isError={block.isError}
              cost={toolsById.get(block.toolUseId)}
              expand={expand}
            />
          ) : null,
        )}
      </div>
    );
  }

  if (message.role === 'assistant') {
    return (
      <article className={[styles.message, styles.assistant, highlighted ? styles.highlight : null].filter(Boolean).join(' ')}>
        <header className={styles.messageHead}>
          <span className={styles.who}>Assistant</span>
          <span className={styles.seq}>#{message.seq}</span>
          {message.ts ? <span className={styles.when}>{formatDate(message.ts, 'time')}</span> : null}
          {message.request ? <RequestChip request={message.request} /> : <span className={styles.muted}>continued message</span>}
        </header>
        <div className={styles.assistantBody}>
          {message.blocks.map((block, index) => {
            const key = `${message.seq}-${index}`;
            switch (block.type) {
              case 'thinking':
                return (
                  <ThinkingBlock
                    key={key}
                    id={`th${key}`}
                    text={block.text}
                    tokens={
                      thinkingTokens === null || thinkingChars === 0
                        ? null
                        : Math.round((block.text.length / thinkingChars) * thinkingTokens)
                    }
                    expand={expand}
                  />
                );
              case 'text':
                return <ClampedText key={key} id={`tx${key}`} expand={expand} text={block.text} />;
              case 'tool_use':
                return (
                  <ToolCallRow
                    key={key}
                    toolUseId={block.id}
                    name={block.name}
                    input={block.input}
                    cost={toolsById.get(block.id)}
                    expand={expand}
                    sessionId={sessionId}
                  />
                );
              case 'tool_result':
                return (
                  <ToolResultRow
                    key={key}
                    id={`r${key}`}
                    toolUseId={block.toolUseId}
                    text={block.text}
                    images={block.images}
                    isError={block.isError}
                    cost={toolsById.get(block.toolUseId)}
                    expand={expand}
                  />
                );
              case 'image':
                return (
                  <p key={key} className={styles.muted}>
                    {plural(block.count, 'image')}
                  </p>
                );
              default:
                return (
                  <p key={key} className={styles.muted}>
                    {block.label}
                  </p>
                );
            }
          })}
        </div>
      </article>
    );
  }

  // Harness plumbing: only rendered when the switch is on.
  const text = textOf(message);
  return (
    <div className={[styles.harness, highlighted ? styles.highlight : null].filter(Boolean).join(' ')}>
      <span className={styles.harnessLabel}>
        <Icon name="info" size={11} /> {message.subtype ?? message.kind}
      </span>
      <span className={styles.seq}>#{message.seq}</span>
      {text ? (
        <div className={styles.harnessBody}>
          <ClampedText id={`h${message.seq}`} expand={expand} mono text={text} />
        </div>
      ) : (
        <span className={styles.muted}>
          {message.blocks.map((block) => (block.type === 'other' ? block.label : '')).join(' ')}
        </span>
      )}
    </div>
  );
}

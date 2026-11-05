import { providerLabel } from '@/lib/provider';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@/lib/navigation';
import { plural } from '@core/pricing/format.js';
import type { SessionSort, SessionSummary } from '@core/types';
import { Button } from '@/components/Button';
import { Callout } from '@/components/Callout';
import { Duration } from '@/components/Duration';
import { EmptyState } from '@/components/EmptyState';
import { Icon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { LedgerTable, type LedgerColumn, type LedgerSort } from '@/components/LedgerTable';
import { ModelChip } from '@/components/ModelChip';
import { Money } from '@/components/Money';
import { RelativeTime } from '@/components/RelativeTime';
import { Skeleton } from '@/components/Skeleton';
import { Tooltip } from '@/components/Tooltip';
import { api } from '@/lib/api';
import { useModelsAnalytics, usePinSession, useSessionsInfinite, useStatus } from '@/lib/queries';
import { useDateRange, rangeLabel } from '@/lib/range';
import { useShortcuts } from '@/lib/keyboard';
import { useElementWidth } from '@/lib/chart';
import { EM_DASH, formatCount } from '@/lib/format';
import { ReportedBadge, ReportedHeader } from './ReportedBadge';
import { TitleSourceHint, shortProjectPath } from './meta';
import { Toolbar } from './Toolbar';
import { useSessionList } from './query';
import { useLedgerWidth, type LedgerWidth } from './viewport';
import styles from './Page.module.css';

/** Which `SessionSort` a sortable column maps to; the server does the ordering. */
const COLUMN_SORT: Record<string, SessionSort> = {
  started: 'started',
  duration: 'duration',
  prompts: 'prompts',
  requests: 'requests',
  tools: 'tools',
  cost: 'cost',
  recent: 'recent',
};

/**
 * Fixed pixel width of every column but the title, and which of them each width bucket shows.
 * The title takes what is left, measured rather than guessed, so a wide window spends its extra
 * pixels on the session name instead of on a gap between two columns.
 */
const COLUMN_PX: Record<string, number> = {
  pin: 48,
  started: 84,
  duration: 89,
  models: 84,
  prompts: 89,
  requests: 81,
  tools: 62,
  agents: 67,
  cost: 93,
  reported: 157,
};

const COLUMN_SETS: Record<LedgerWidth, readonly string[]> = {
  narrow: ['pin', 'title', 'cost'],
  mid: ['pin', 'title', 'started', 'duration', 'requests', 'cost'],
  rich: ['pin', 'title', 'started', 'duration', 'models', 'prompts', 'requests', 'cost', 'reported'],
  full: ['pin', 'title', 'started', 'duration', 'models', 'prompts', 'requests', 'tools', 'agents', 'cost', 'reported'],
};

const MIN_TITLE_PX = 120;

/** `LedgerTable`'s header/cell padding (`8px 12px`), which a border-box column width includes. */
const CELL_PADDING_PX = 24;

/** How long the session actually ran: active time when the parser found any, else wall clock. */
function elapsedOf(session: SessionSummary): number {
  return session.activeMs > 0 ? session.activeMs : session.durationMs;
}

export default function SessionsPage() {
  const navigate = useNavigate();
  const range = useDateRange();
  const list = useSessionList();
  const pin = usePinSession();
  const sessions = useSessionsInfinite(list.query);
  const models = useModelsAnalytics(range.query);
  const status = useStatus();
  const ledgerWidth = useLedgerWidth();
  const narrow = ledgerWidth === 'narrow';
  // Sessions the scratch filter is keeping out of this table. Without the note the footer's
  // count and the index count in the top bar disagree with nothing to explain the gap.
  const scratchHidden = status.data?.scratchSessions ?? 0;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tableWidth = useElementWidth(bodyRef, 0);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const titlePx = useMemo(() => {
    if (tableWidth <= 0) return null;
    const others = COLUMN_SETS[ledgerWidth]
      .filter((id) => id !== 'title')
      .reduce((sum, id) => sum + (COLUMN_PX[id] ?? 0), 0);
    // A couple of pixels for the table's own border.
    return Math.max(MIN_TITLE_PX, tableWidth - others - 6);
  }, [tableWidth, ledgerWidth]);

  const rows = useMemo(
    () => (sessions.data?.pages ?? []).flatMap((page) => page.sessions),
    [sessions.data],
  );
  const first = sessions.data?.pages[0];
  const total = first?.total ?? 0;
  const totalCost = first?.totalCost ?? 0;
  const loadingTotals = sessions.isPending;

  const rowAt = useCallback(
    (index: number): SessionSummary | undefined => rows[index],
    [rows],
  );

  const focusedIndex = useCallback((): number => {
    const active = document.activeElement;
    const row = active instanceof HTMLElement ? active.closest('tr[data-row-index]') : null;
    const index = row ? Number(row.getAttribute('data-row-index')) : Number.NaN;
    return Number.isFinite(index) ? index : -1;
  }, []);

  const focusRow = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, rows.length - 1));
      const node = bodyRef.current?.querySelector<HTMLElement>(`tr[data-row-index="${clamped}"]`);
      node?.focus();
      setFocusedId(rowAt(clamped)?.id ?? null);
    },
    [rows.length, rowAt],
  );

  useShortcuts([
    { id: 'sessions-next', keys: 'j', description: 'Next session', group: 'Rows', run: () => focusRow(focusedIndex() + 1) },
    {
      id: 'sessions-prev',
      keys: 'k',
      description: 'Previous session',
      group: 'Rows',
      run: () => focusRow(focusedIndex() <= 0 ? 0 : focusedIndex() - 1),
    },
    {
      id: 'sessions-pin',
      keys: 'p',
      description: 'Pin or unpin the focused session',
      group: 'Rows',
      run: () => {
        const session = rowAt(focusedIndex());
        if (session) pin.mutate(session.id);
      },
    },
  ]);

  const columns = useMemo<LedgerColumn<SessionSummary>[]>(() => {
    const pinColumn: LedgerColumn<SessionSummary> = {
      id: 'pin',
      header: <span className="visually-hidden">Pinned</span>,
      width: `${COLUMN_PX.pin}px`,
      cell: (session) => (
        <IconButton
          icon="pin"
          size="sm"
          active={session.pinned}
          label={session.pinned ? `Unpin ${session.title}` : `Pin ${session.title}`}
          onClick={(event) => {
            event.stopPropagation();
            pin.mutate(session.id);
          }}
        />
      ),
    };

    const titleColumn: LedgerColumn<SessionSummary> = {
      id: 'title',
      header: 'Session',
      ...(titlePx === null ? {} : { width: `${titlePx}px` }),
      headerTitle: 'Session title and the project it ran in',
      cell: (session) => (
        <span
          className={styles.titleCell}
          // A table cell of nowrap text reports the whole string as its minimum width, so the
          // width the column was given only holds if the cell is capped too — inside the cell's
          // own padding, or the column grows by that much again.
          style={
            titlePx === null
              ? undefined
              : { width: titlePx - CELL_PADDING_PX, maxWidth: titlePx - CELL_PADDING_PX }
          }
        >
          <span className={styles.titleLine}>
            <Link
              className={styles.titleLink}
              to={`/sessions/${encodeURIComponent(session.id)}`}
              title={session.title}
              onClick={(event) => event.stopPropagation()}
            >
              {session.title}
            </Link>
            <TitleSourceHint source={session.titleSource} />
            {session.continuedInSessionId ? (
              <Tooltip content="This session ran out of context and was continued in another one. Open the next link in the chain.">
                <Link
                  className={styles.chain}
                  to={`/sessions/${encodeURIComponent(session.continuedInSessionId)}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Icon name="external" size={11} /> chain
                </Link>
              </Tooltip>
            ) : null}
          </span>
          <span className={styles.subLine} title={session.projectPath}>
            {providerLabel(session.provider)} · {shortProjectPath(session.projectPath)}
            {session.gitBranch ? <span className={styles.branch}> · {session.gitBranch}</span> : null}
          </span>
          {/* Two columns is all a phone has room for, so the facts the other columns would have
              carried are spelled out here instead of being dropped. */}
          {narrow ? (
            <span className={styles.subLine}>
              <RelativeTime value={session.startedAt} live={false} /> · <Duration ms={elapsedOf(session)} /> ·{' '}
              {plural(session.requestCount, 'request')}
            </span>
          ) : null}
        </span>
      ),
    };

    const costColumn: LedgerColumn<SessionSummary> = {
      id: 'cost',
      header: 'Cost',
      numeric: true,
      width: `${COLUMN_PX.cost}px`,
      sortValue: (session) => session.cost.total,
      cell: (session) => (
        <span className={styles.costCell}>
          {session.usageIncomplete && session.requestCount === 0 ? (
            <Tooltip content="This rollout contains assistant messages but no recorded token usage. Its cost is unavailable.">
              <span className="muted">Unavailable</span>
            </Tooltip>
          ) : <Money usd={session.cost.total} className={styles.cost} />}
          {session.usageIncomplete && session.requestCount > 0 ? (
            <Tooltip content="Some token usage is missing. This total covers recorded tokens only.">
              <span className={styles.unpriced} aria-label="Incomplete usage"><Icon name="warning" size={12} /></span>
            </Tooltip>
          ) : null}
          {session.unpriced ? (
            <Tooltip content="This session used a model with no price in the pricing table, so its total is a floor. Add a price in Settings.">
              <span className={styles.unpriced} aria-label="Unpriced model">
                <Icon name="warning" size={12} />
              </span>
            </Tooltip>
          ) : null}
        </span>
      ),
    };

    const started: LedgerColumn<SessionSummary> = {
      id: 'started',
      header: 'Started',
      width: `${COLUMN_PX.started}px`,
      headerTitle: 'When the session started; hover for the exact date',
      sortValue: (session) => session.startedAt,
      // One figure per cell: the duration used to sit under this one with no header of its own,
      // and the absolute date lives in the `<time>` element's tooltip.
      cell: (session) => <RelativeTime value={session.startedAt} live={false} className={styles.time} />,
    };

    const duration: LedgerColumn<SessionSummary> = {
      id: 'duration',
      header: 'Duration',
      numeric: true,
      width: `${COLUMN_PX.duration}px`,
      headerTitle: 'How long the session stayed active: idle gaps between turns are excluded',
      sortValue: (session) => elapsedOf(session),
      cell: (session) => <Duration ms={elapsedOf(session)} />,
    };

    const models: LedgerColumn<SessionSummary> = {
      id: 'models',
      header: 'Models',
      width: `${COLUMN_PX.models}px`,
      cell: (session) => (
        <span className={styles.models}>
          {session.models.slice(0, 3).map((model) => (
            <ModelChip key={model} model={model} glyphOnly />
          ))}
          {session.models.length > 3 ? <span className={styles.more}>+{session.models.length - 3}</span> : null}
        </span>
      ),
    };

    const prompts: LedgerColumn<SessionSummary> = {
      id: 'prompts',
      header: 'Prompts',
      numeric: true,
      width: `${COLUMN_PX.prompts}px`,
      sortValue: (session) => session.promptCount,
      cell: (session) => formatCount(session.promptCount),
    };

    const requests: LedgerColumn<SessionSummary> = {
      id: 'requests',
      header: 'Requests',
      numeric: true,
      width: `${COLUMN_PX.requests}px`,
      headerTitle: 'Billed API calls in this session, subagents included',
      sortValue: (session) => session.requestCount,
      cell: (session) => formatCount(session.requestCount),
    };

    const tools: LedgerColumn<SessionSummary> = {
      id: 'tools',
      header: 'Tools',
      numeric: true,
      width: `${COLUMN_PX.tools}px`,
      headerTitle: 'Tool calls made in this session, subagents included',
      sortValue: (session) => session.toolCallCount,
      cell: (session) => formatCount(session.toolCallCount),
    };

    const agents: LedgerColumn<SessionSummary> = {
      id: 'agents',
      header: 'Agents',
      numeric: true,
      width: `${COLUMN_PX.agents}px`,
      headerTitle: 'Subagents this session launched, and workflow runs',
      cell: (session) =>
        session.provider === 'codex' ? <span title="Agent and workflow attribution unavailable for Codex">{EM_DASH}</span> : session.agentCount > 0 || session.workflowRunCount > 0 ? (
          <span
            title={`${plural(session.agentCount, 'subagent')} and ${plural(session.workflowRunCount, 'workflow run')}`}
          >
            {formatCount(session.agentCount + session.workflowRunCount)}
          </span>
        ) : (
          <span className={styles.zero}>{EM_DASH}</span>
        ),
    };

    const reported: LedgerColumn<SessionSummary> = {
      id: 'reported',
      header: <ReportedHeader />,
      width: `${COLUMN_PX.reported}px`,
      cell: (session) => session.provider === 'codex' ? <span title="Codex has no Claude Code cost-state tally">{EM_DASH}</span> : <ReportedBadge status={session.reportedStatus} />,
    };

    // Widest set that fits, never at the cost of the two columns that carry the answer.
    if (ledgerWidth === 'narrow') return [pinColumn, titleColumn, costColumn];
    if (ledgerWidth === 'mid') return [pinColumn, titleColumn, started, duration, requests, costColumn];
    if (ledgerWidth === 'rich') {
      return [pinColumn, titleColumn, started, duration, models, prompts, requests, costColumn, reported];
    }
    return [pinColumn, titleColumn, started, duration, models, prompts, requests, tools, agents, costColumn, reported];
  }, [pin, narrow, ledgerWidth, titlePx]);

  const sort: LedgerSort = { columnId: list.filters.sort, direction: list.filters.order };
  const onSortChange = useCallback(
    (next: LedgerSort) => {
      const mapped = COLUMN_SORT[next.columnId];
      if (mapped) list.set({ sort: mapped, order: next.direction });
    },
    [list],
  );

  const footer = useMemo(() => {
    const cells: ReactNode[] = columns.map(() => null);
    const titleAt = columns.findIndex((column) => column.id === 'title');
    const costAt = columns.findIndex((column) => column.id === 'cost');
    if (titleAt >= 0) {
      cells[titleAt] = (
        <span className={styles.footerLabel}>
          {plural(total, 'session')} · {rangeLabel(range.value)}
          {scratchHidden > 0 ? (
            <>
              {' · '}
              <Link to="/settings#appearance" className={styles.footerLink}>
                {formatCount(scratchHidden)} scratch hidden
              </Link>
            </>
          ) : null}
        </span>
      );
    }
    if (costAt >= 0) cells[costAt] = <Money usd={totalCost} className={styles.cost} />;
    return cells;
  }, [columns, total, totalCost, range.value, scratchHidden]);

  return (
    <div className="stack">
      <header className={styles.head}>
        <div>
          <p className="eyebrow">Ledger</p>
          <h1>Sessions</h1>
        </div>
        {/* A count and a total that both read zero while the first page is in flight say
            something false with great confidence; a skeleton says "not yet". */}
        {loadingTotals ? (
          <p className={styles.headTotals} aria-busy="true">
            <Skeleton width={72} height={12} label="Counting sessions" />
            <Skeleton width={132} height={30} />
          </p>
        ) : (
          <p className={styles.headTotals}>
            <span className="num">{formatCount(total)}</span> {total === 1 ? 'session' : 'sessions'} ·{' '}
            <Money usd={totalCost} display className={styles.headMoney} />
          </p>
        )}
      </header>

      <Toolbar list={list} models={models.data?.models ?? []} csvHref={api.sessionsCsvHref(list.query)} />

      {sessions.isError ? (
        <Callout tone="warn" title="The session list could not be loaded">
          The index may still be building. Try again once indexing finishes.
        </Callout>
      ) : null}

      <div ref={bodyRef}>
        <LedgerTable
          columns={columns}
          rows={rows}
          rowKey={(session) => session.id}
          caption={`Sessions, ${rangeLabel(range.value)}`}
          rowHeight={narrow ? 64 : 42}
          loading={sessions.isPending}
          manualSort
          sort={sort}
          onSortChange={onSortChange}
          selectedKey={focusedId}
          onActivateRow={(session) => navigate(`/sessions/${encodeURIComponent(session.id)}`)}
          activateLabel="opens this session"
          rowActions={[{ key: 'p', label: 'pins or unpins this session', run: (session) => pin.mutate(session.id) }]}
          footer={rows.length > 0 ? footer : undefined}
          empty={
            <EmptyState
              inline
              icon="sessions"
              title="No sessions match these filters"
              description="Widen the date range, or clear the filters above."
            />
          }
        />
      </div>

      {sessions.hasNextPage ? (
        <div className={styles.loadMore}>
          <Button
            variant="secondary"
            loading={sessions.isFetchingNextPage}
            onClick={() => void sessions.fetchNextPage()}
          >
            Load more · {formatCount(rows.length)} of {plural(total, 'session')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

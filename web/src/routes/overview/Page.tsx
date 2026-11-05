import { useMemo, type ReactNode } from 'react';
import { Link } from '@/lib/navigation';
import type { OverviewResponse, RangeQuery } from '@core/types';
import { plural } from '@core/pricing/format.js';
import {
  Callout,
  ChartFrame,
  EmptyState,
  HeatStrip,
  Kpi,
  LedgerTable,
  LinkButton,
  Money,
  Tokens,
  type KpiDelta,
  type LedgerColumn,
} from '@/components';
import { useCurrency } from '@/lib/currency';
import { formatCount, formatDate, formatMoney, formatPercent, fromIsoDay, toIsoDay } from '@/lib/format';
import { PageHeader, QueryError, Section } from '@/lib/page';
import { useOverview } from '@/lib/queries';
import { fillDailySeries, formatRangeSentence, useDateRange } from '@/lib/range';
import { useWhatIf } from '@/lib/whatif';
import { InsightCard } from '@/routes/insights/components';
import {
  BudgetPanel,
  CategorySplit,
  ModelSpend,
  OverviewSkeleton,
  PlanPanel,
  ProjectSpend,
  TopSessions,
  WhatIfPicker,
} from './components';
import { deltaFraction, previousWindow, priorTooSmall } from './previous';
import styles from './Page.module.css';

type DailyRow = OverviewResponse['daily'][number];

/** The daily strip only becomes scrollable-wide past this, so the table view earns a max height. */
const DAILY_TABLE_ROWS = 16;

/** The API returns one entry per non-empty day; a zero day still has to occupy its slot. */
function emptyDay(date: string): DailyRow {
  return {
    date,
    cost: 0,
    requests: 0,
    sessions: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0, thinking: 0, webSearchRequests: 0, context: 0 },
  };
}

/** The range the ledger opens on: everything that happened, priced, in one page. */
export default function OverviewPage() {
  const range = useDateRange();
  const whatIf = useWhatIf();
  const currency = useCurrency();

  const query = useMemo<RangeQuery>(() => ({ ...range.query, whatIf: whatIf.param }), [range.query, whatIf.param]);
  const overview = useOverview(query);

  // At list prices, for the what-if delta. Identical query key when no substitution is active,
  // so the simulator costs nothing until it is used.
  const baseline = useOverview(range.query);

  // The equal-length window before this one. Derived from the range the *server* resolved, so
  // an unbounded range still gets a like-for-like comparison. Until that arrives we re-issue the
  // current query (a cache hit, not a second request) and render no deltas.
  const resolved = overview.data?.range ?? null;
  const previousBounds = resolved ? previousWindow(resolved.from, resolved.to) : null;
  const previous = useOverview(
    previousBounds ? { ...query, from: previousBounds.from, to: previousBounds.to } : query,
  );
  // Kept even when the previous window billed nothing: an empty prior window is worth stating
  // once, and is exactly the case a percentage cannot describe.
  const comparison = previousBounds && previous.data ? previous.data.totals : null;

  const totals = overview.data?.totals;

  /**
   * Whether a percentage against the previous window means anything at all. Judged on spend,
   * which is the metric the whole page is about: a prior window holding under a tenth of this
   * one's spend cannot describe any of the six KPIs, and six copies of "vs $0.00 prior" say
   * less than one sentence saying so.
   */
  const priorComparable =
    comparison !== null && totals !== undefined && !priorTooSmall(totals.cost.total, comparison.cost.total);

  /**
   * The comparison line under a KPI. A percentage when the previous window holds enough to
   * compare against; otherwise the prior figure in words, because "▲ 1,428%" against an almost
   * empty month reads as an alarm about spend when it is really a statement about coverage.
   */
  const compare = (
    current: number | undefined,
    before: number | undefined,
    good: KpiDelta['good'],
    render: (value: number) => ReactNode,
  ): { delta?: KpiDelta; note?: ReactNode } => {
    if (!priorComparable || current === undefined || before === undefined) return {};
    if (priorTooSmall(current, before)) return { note: <>vs {render(before)} prior</> };
    const fraction = deltaFraction(current, before);
    return fraction === null ? {} : { delta: { fraction, good } };
  };

  const asMoney = (value: number): ReactNode => <Money usd={value} currency={currency} />;
  const asCount = (value: number): ReactNode => <span className="num">{formatCount(value)}</span>;
  const asPercent = (value: number): ReactNode => <span className="num">{formatPercent(value)}</span>;

  const whatIfDelta =
    whatIf.active && overview.data && baseline.data
      ? overview.data.totals.cost.total - baseline.data.totals.cost.total
      : null;

  // One entry per day across the window, in date order: the API only returns days that billed
  // something, and a strip of flex cells silently dropped the rest — a month with five working
  // days drew five cells and read as a month of solid work.
  const days = useMemo(
    () => (overview.data ? fillDailySeries(overview.data.daily, resolved?.from, resolved?.to, emptyDay) : []),
    [overview.data, resolved?.from, resolved?.to],
  );

  const peakDay = useMemo(() => days.reduce<DailyRow | null>((peak, day) => (peak && peak.cost >= day.cost ? peak : day), null), [days]);
  const todayDay = useMemo(() => {
    const today = toIsoDay(new Date());
    return days.find((day) => day.date === today) ?? null;
  }, [days]);
  const blankDays = useMemo(() => days.filter((day) => day.cost <= 0).length, [days]);

  const dailyColumns = useMemo<LedgerColumn<DailyRow>[]>(
    () => [
      {
        id: 'date',
        header: 'Day',
        width: '34%',
        sortValue: (row) => row.date,
        cell: (row) => formatDate(fromIsoDay(row.date), 'date'),
      },
      { id: 'requests', header: 'Requests', numeric: true, sortValue: (row) => row.requests, cell: (row) => formatCount(row.requests) },
      { id: 'sessions', header: 'Sessions', numeric: true, sortValue: (row) => row.sessions, cell: (row) => formatCount(row.sessions) },
      {
        id: 'context',
        header: 'Context tok',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.tokens.context,
        cell: (row) => <Tokens value={row.tokens.context} />,
      },
      {
        id: 'cost',
        header: 'Cost',
        numeric: true,
        sortValue: (row) => row.cost,
        cell: (row) => (row.cost > 0 ? <Money usd={row.cost} currency={currency} /> : <span className="muted-2">—</span>),
      },
    ],
    [currency],
  );

  const rangeSentence = formatRangeSentence(resolved?.from, resolved?.to);

  const dailySummary = [
    `Daily spend across ${plural(days.length, 'day')}`,
    peakDay && peakDay.cost > 0
      ? `, peaking at ${formatMoney(peakDay.cost)} on ${formatDate(fromIsoDay(peakDay.date), 'date')}`
      : '',
    '.',
    blankDays > 0 ? ` ${plural(blankDays, 'day')} billed nothing.` : '',
  ].join('');

  /** What the delta slot says when there is no prior window worth a percentage. */
  const spendNote: ReactNode = priorComparable
    ? undefined
    : todayDay && todayDay.cost > 0
      ? (
          <>
            <Money usd={todayDay.cost} currency={currency} /> today
          </>
        )
      : peakDay && peakDay.cost > 0
        ? (
            <>
              <Money usd={peakDay.cost} currency={currency} /> on {formatDate(fromIsoDay(peakDay.date), 'day')}, the peak day
            </>
          )
        : undefined;

  return (
    <div className={`stack stack-lg ${styles.page}`}>
      <PageHeader
        title="Overview"
        lead={
          <>
            {`${rangeSentence} · recorded Claude Code and Codex usage, priced at API list rates.`}
            {priorComparable && previousBounds
              ? ` Compared with ${formatRangeSentence(previousBounds.from, previousBounds.to)}.`
              : ''}
          </>
        }
        actions={<WhatIfPicker deltaUsd={whatIfDelta} currency={currency} />}
      />

      {overview.isError ? (
        <QueryError error={overview.error} what="the overview" onRetry={() => void overview.refetch()} />
      ) : null}

      {overview.isPending ? <OverviewSkeleton /> : null}

      {overview.data && totals ? (
        totals.requests === 0 ? (
          <EmptyState
            title="Nothing billed in this range"
            description={`No API request between ${rangeSentence}. Widen the date range, or clear the project filter.`}
            icon="overview"
            action={
              <LinkButton to="/" variant="secondary">
                Reset the range
              </LinkButton>
            }
          />
        ) : (
          <>
            {overview.data.unpricedModels.length > 0 ? (
              <Callout tone="warn" title="Unpriced models in this range" action={<Link to="/settings#pricing">Add prices</Link>}>
                <span className={styles.unpriced}>
                  {overview.data.unpricedModels.map((model) => (
                    <code key={model}>{model}</code>
                  ))}
                </span>{' '}
                counted tokens but no money, so every total on this page is a floor.
              </Callout>
            ) : null}

            <div className="grid-kpis grid-kpis-6">
              <Kpi
                label="Spend"
                size="lg"
                value={<Money usd={totals.cost.total} currency={currency} display />}
                {...compare(totals.cost.total, comparison?.cost.total, 'down', asMoney)}
                note={spendNote}
                hint="Exact: every billed request in range, at the configured list prices."
              />
              <Kpi
                label="Requests"
                value={<span className="num-display">{formatCount(totals.requests)}</span>}
                sub={<Tokens value={totals.tokens.context} unit="ctx tok" />}
                {...compare(totals.requests, comparison?.requests, 'none', asCount)}
                hint="Deduplicated assistant messages: one per billed API call."
              />
              <Kpi
                label="Sessions with requests"
                value={<span className="num-display">{formatCount(totals.sessions)}</span>}
                sub={plural(totals.agents, 'agent')}
                {...compare(totals.sessions, comparison?.sessions, 'none', asCount)}
                hint="Sessions that billed at least one request inside this range. The Sessions page counts sessions by the day they started, so a session that began earlier and kept running is counted here but not there — the two numbers are meant to differ."
              />
              <Kpi
                label="Prompts"
                value={<span className="num-display">{formatCount(totals.prompts)}</span>}
                sub={plural(totals.toolCalls, 'tool call')}
                {...compare(totals.prompts, comparison?.prompts, 'none', asCount)}
              />
              <Kpi
                label="Cache hit ratio"
                value={<span className="num-display">{formatPercent(totals.cacheHitRatio)}</span>}
                {...compare(totals.cacheHitRatio, comparison?.cacheHitRatio, 'up', asPercent)}
                hint="Cache reads as a share of all context tokens. Higher is cheaper: a cache read costs a tenth of an input token."
              />
              <Kpi
                label="Cost per prompt"
                value={<Money usd={totals.costPerPrompt} currency={currency} display />}
                {...compare(totals.costPerPrompt, comparison?.costPerPrompt, 'down', asMoney)}
                hint="Range spend divided by the number of human prompts, including everything the prompt set in motion."
              />
            </div>

            {/* Said once, under the row, rather than six times inside it. */}
            {!priorComparable && previousBounds && comparison ? (
              <p className={styles.priorNote}>
                No comparable prior period: {formatRangeSentence(previousBounds.from, previousBounds.to)} billed{' '}
                <Money usd={comparison.cost.total} currency={currency} />, so these figures carry no percentages.
              </p>
            ) : null}

            <section aria-labelledby="daily-heading" className={styles.heatFrame}>
              <ChartFrame
                summary={dailySummary}
                title={<h2 id="daily-heading">Daily spend</h2>}
                legend={<span className={styles.heatHint}>Pick a day to narrow the range to it</span>}
                table={
                  <LedgerTable
                    columns={dailyColumns}
                    rows={days}
                    rowKey={(row) => row.date}
                    caption="Spend by day across the selected range"
                    defaultSort={{ columnId: 'date', direction: 'asc' }}
                    maxHeight={days.length > DAILY_TABLE_ROWS ? 420 : undefined}
                    empty="No day in this range."
                    dense
                  />
                }
              >
                <HeatStrip
                  days={days}
                  selectedDate={range.value.from && range.value.from === range.value.to ? range.value.from : null}
                  onSelect={(day) =>
                    range.setBounds(
                      range.value.from === day.date && range.value.to === day.date
                        ? { from: resolved?.from, to: resolved?.to }
                        : { from: day.date, to: day.date },
                    )
                  }
                  ariaLabel="Daily spend across the selected range"
                />
              </ChartFrame>
            </section>

            <section aria-labelledby="models-heading" className="stack">
              <ModelSpend
                models={overview.data.byModel}
                total={totals.cost.total}
                currency={currency}
                headingId="models-heading"
              />
            </section>

            <Section title="Spend by project" note="open a row for its sessions">
              <ProjectSpend
                rows={overview.data.byProject}
                total={totals.cost.total}
                currency={currency}
                range={{ from: range.value.from, to: range.value.to }}
              />
            </Section>

            <Section title="Where the money went">
              <CategorySplit categories={overview.data.byCategory} tokens={totals.tokens} currency={currency} />
            </Section>

            <Section
              title="Most expensive sessions"
              actions={
                <LinkButton to="/sessions" variant="ghost" size="sm">
                  All sessions
                </LinkButton>
              }
            >
              <TopSessions sessions={overview.data.topSessions} currency={currency} />
            </Section>

            <Section title="Plan and budget">
              <div className="stack">
                <PlanPanel plan={overview.data.plan} budget={overview.data.budget} currency={currency} />
                <BudgetPanel budget={overview.data.budget} currency={currency} />
              </div>
            </Section>

            {overview.data.insights.length > 0 ? (
              <Section
                title="Top insights"
                actions={
                  <LinkButton to="/insights" variant="ghost" size="sm">
                    All insights
                  </LinkButton>
                }
              >
                <ul className={styles.insightList}>
                  {overview.data.insights.slice(0, 3).map((insight) => (
                    <li key={insight.id}>
                      <InsightCard insight={insight} currency={currency} compact maxSessions={2} />
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

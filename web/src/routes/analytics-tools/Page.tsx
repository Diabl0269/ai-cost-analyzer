import { useId, useMemo, useState } from 'react';
import { plural } from '@core/pricing/format';
import {
  CountCell,
  EmptyState,
  EstimateBadge,
  Kpi,
  LedgerTable,
  Money,
  SegmentedControl,
  Skeleton,
  Tokens,
  type LedgerColumn,
} from '@/components';
import { BarLegend, SplitBar } from '@/lib/bars';
import { useCurrency } from '@/lib/currency';
import { formatCount, formatPercent } from '@/lib/format';
import { PageHeader, QueryError, Section } from '@/lib/page';
import { useToolsAnalytics } from '@/lib/queries';
import { useDateRange } from '@/lib/range';
import { buildToolRows, type ToolGrouping, type ToolRow } from './rows';
import styles from './Page.module.css';

/** Generate / ingest / carry, in the order they happen to a tool result. */
const COST_PARTS = [
  { id: 'genCost', label: 'Generate', color: 'var(--t-output)', pattern: 'solid' as const },
  { id: 'ingestCost', label: 'Ingest', color: 'var(--t-cache-write)', pattern: 'hatch' as const },
  { id: 'carryCost', label: 'Carry', color: 'var(--t-cache-read)', pattern: 'dots' as const },
];

/**
 * Generate, ingest, carry and their total are all attributed from exact request costs rather
 * than billed separately. That is one fact about four adjacent columns, so it is said once in a
 * spanning group header instead of five times across the header row. `Tokens` keeps a badge of
 * its own: it sits outside the group and is a different estimate (characters → tokens).
 */
const ATTRIBUTION_GROUP = [
  {
    id: 'attribution',
    label: (
      <span className={styles.groupLabel}>
        Estimated attribution
        <EstimateBadge method="delta" detail="Tool cost is an attribution of request cost, not a separate bill." />
      </span>
    ),
    columns: ['genCost', 'ingestCost', 'carryCost', 'totalCost'],
  },
];

const ATTRIBUTED = <EstimateBadge method="delta" detail="Tool cost is an attribution of request cost, not a separate bill." />;

/** What every tool call cost: the JSON that asked for it, and the result that stayed in context. */
export default function ToolsAnalyticsPage() {
  const range = useDateRange();
  const currency = useCurrency();
  const tools = useToolsAnalytics(range.query);
  const [filter, setFilter] = useState('');
  const [grouping, setGrouping] = useState<ToolGrouping>('tool');
  const filterId = useId();

  const rows = useMemo(
    () => buildToolRows(tools.data?.tools ?? [], filter, grouping),
    [tools.data, filter, grouping],
  );

  const shownTotal = rows.reduce((sum, row) => sum + row.totalCost, 0);
  const totals = useMemo(() => {
    const all = tools.data?.tools ?? [];
    return {
      calls: all.reduce((sum, row) => sum + row.calls, 0),
      errors: all.reduce((sum, row) => sum + row.errors, 0),
      carry: all.reduce((sum, row) => sum + row.carryCost, 0),
      child: all.reduce((sum, row) => sum + row.childCost, 0),
      tools: all.length,
    };
  }, [tools.data]);

  const columns = useMemo<LedgerColumn<ToolRow>[]>(() => {
    const list: LedgerColumn<ToolRow>[] = [
      {
        id: 'name',
        header: grouping === 'server' ? 'Server' : 'Tool',
        width: '18%',
        sortValue: (row) => row.name,
        cell: (row) => (
          <span className={styles.toolName}>
            <span className="truncate">{row.name}</span>
            {grouping === 'server' ? (
              <span className={styles.server}>{plural(row.tools, 'tool')}</span>
            ) : row.server ? (
              <span className={`${styles.server} truncate`}>{row.server}</span>
            ) : null}
          </span>
        ),
      },
      { id: 'calls', header: 'Calls', numeric: true, sortValue: (row) => row.calls, cell: (row) => formatCount(row.calls) },
      {
        id: 'errors',
        header: 'Errors',
        numeric: true,
        sortValue: (row) => row.errors,
        headerTitle: 'Calls whose result came back an error',
        cell: (row) => <CountCell value={row.errors} tone="cost" noun="errored calls" />,
      },
    ];
    if (grouping === 'tool') {
      list.push({
        id: 'sessions',
        header: 'Sessions',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.sessions,
        cell: (row) => formatCount(row.sessions),
      });
    }
    list.push(
      {
        id: 'avgResult',
        header: 'Avg chars',
        width: '9%',
        numeric: true,
        secondary: true,
        headerTitle: 'Average number of characters this tool returned per call',
        sortValue: (row) => row.avgResultChars,
        cell: (row) => formatCount(Math.round(row.avgResultChars)),
      },
      {
        id: 'resultTokens',
        header: 'Tokens',
        numeric: true,
        secondary: true,
        headerTitle: 'Tokens the results added to the context, estimated from their characters',
        headerAside: ATTRIBUTED,
        sortValue: (row) => row.totalResultTokens,
        cell: (row) => <Tokens value={Math.round(row.totalResultTokens)} />,
      },
      {
        id: 'mix',
        header: 'Split',
        headerTitle: 'Generate, ingest and carry as a proportion of this row',
        width: '92px',
        sortValue: (row) => row.totalCost,
        cell: (row) => (
          <SplitBar
            segments={COST_PARTS.map((part) => ({
              id: part.id,
              label: part.label,
              value: row[part.id as 'genCost' | 'ingestCost' | 'carryCost'],
              color: part.color,
              pattern: part.pattern,
            }))}
          />
        ),
      },
      {
        id: 'genCost',
        header: 'Generate',
        headerTitle: 'Output tokens spent writing the tool call',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.genCost,
        cell: (row) => <Money usd={row.genCost} currency={currency} />,
      },
      {
        id: 'ingestCost',
        header: 'Ingest',
        headerTitle: 'Reading the result into the context the first time',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.ingestCost,
        cell: (row) => <Money usd={row.ingestCost} currency={currency} />,
      },
      {
        id: 'carryCost',
        header: 'Carry',
        headerTitle: 'Re-sending the result on every later request in the conversation',
        numeric: true,
        sortValue: (row) => row.carryCost,
        cell: (row) => <Money usd={row.carryCost} currency={currency} />,
      },
      {
        id: 'totalCost',
        header: 'Total',
        headerTitle: 'Generate + ingest + carry',
        numeric: true,
        sortValue: (row) => row.totalCost,
        cell: (row) => <Money usd={row.totalCost} currency={currency} />,
      },
      {
        id: 'childCost',
        header: 'Delegated',
        numeric: true,
        headerTitle:
          'Exact cost of the agents and workflow runs these calls launched. Never added to the total above, so it is not counted twice.',
        sortValue: (row) => row.childCost,
        cell: (row) => (row.childCost > 0 ? <Money usd={row.childCost} currency={currency} /> : <span className="muted-2">—</span>),
      },
    );
    return list;
  }, [currency, grouping]);

  if (range.provider === 'copilot') {
    return <div className={`stack stack-lg ${styles.page}`}>
      <PageHeader title="Tools" lead="Recorded Copilot tool activity. Per-tool costs are unavailable from saved session totals." />
      {tools.isError ? <QueryError error={tools.error} what="the tool analytics" onRetry={() => void tools.refetch()} /> : null}
      {tools.isPending ? <Skeleton height={280} label="Loading tool activity" /> : null}
      {tools.data ? <LedgerTable columns={columns.filter(column => ['name', 'calls', 'errors', 'sessions', 'avgResult'].includes(column.id))} rows={rows} rowKey={row => row.name} caption="Recorded Copilot tool activity" defaultSort={{ columnId: 'calls', direction: 'desc' }} empty="No tool activity recorded." /> : null}
    </div>;
  }

  return (
    <div className={`stack stack-lg ${styles.page}`}>
      <PageHeader
        title="Tools"
        lead="What each tool cost: the output tokens that wrote the call, plus the estimated ingest and carry of everything it returned."
      />

      {tools.isError ? (
        <QueryError error={tools.error} what="the tool analytics" onRetry={() => void tools.refetch()} />
      ) : null}

      {tools.isPending ? (
        <div className="stack" aria-busy="true">
          <Skeleton height={96} label="Loading tool analytics" />
          <Skeleton height={280} />
        </div>
      ) : null}

      {tools.data ? (
        <>
          <div className="grid-kpis">
            <Kpi
              label="Tool cost"
              size="lg"
              value={<Money usd={tools.data.total} currency={currency} display />}
              sub={<EstimateBadge method="delta" size="md" />}
              hint="Generate + ingest + carry for every tool call in range. An attribution of exact request costs, not a separate bill."
            />
            <Kpi
              label="Carry share"
              value={<span className="num-display">{formatPercent(tools.data.total > 0 ? totals.carry / tools.data.total : 0)}</span>}
              sub={<Money usd={totals.carry} currency={currency} />}
              hint="Share of tool cost spent re-sending results that were already in the context."
            />
            <Kpi
              label="Calls"
              value={<span className="num-display">{formatCount(totals.calls)}</span>}
              sub={`${plural(totals.tools, 'distinct tool')}`}
            />
            <Kpi
              label="Errors"
              value={<span className="num-display">{formatCount(totals.errors)}</span>}
              sub={formatPercent(totals.calls > 0 ? totals.errors / totals.calls : 0)}
            />
            <Kpi
              label="Delegated cost"
              value={<Money usd={totals.child} currency={currency} display />}
              sub="agents and workflows"
              hint="Exact cost of the transcripts that Agent and Workflow calls started. Reported separately so it is never double counted."
            />
          </div>

          <Section title="Every tool in range" note="sortable; open a column header to re-rank">
            <div className="stack">
              <div className={styles.toolbar}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor={filterId}>
                    Filter
                  </label>
                  <input
                    id={filterId}
                    type="search"
                    className={styles.input}
                    value={filter}
                    placeholder="Tool or MCP server name"
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </div>
                <SegmentedControl
                  label="Group rows"
                  value={grouping}
                  onChange={setGrouping}
                  options={[
                    { value: 'tool', label: 'Per tool' },
                    { value: 'server', label: 'By MCP server' },
                  ]}
                />
                <span className={styles.count}>
                  {plural(rows.length, 'row')} · <Money usd={shownTotal} currency={currency} />
                </span>
              </div>

              <BarLegend segments={COST_PARTS} />

              {rows.length === 0 ? (
                <EmptyState
                  inline
                  title="No tool matches"
                  description={filter ? `Nothing in this range matches “${filter}”.` : 'No tool call was recorded in this range.'}
                  icon="tools"
                />
              ) : (
                <LedgerTable
                  columns={columns}
                  rows={rows}
                  rowKey={(row) => row.key}
                  caption="Tool cost in the selected range"
                  columnGroups={ATTRIBUTION_GROUP}
                  defaultSort={{ columnId: 'totalCost', direction: 'desc' }}
                  maxHeight={rows.length > 24 ? 640 : undefined}
                  dense
                />
              )}
            </div>
          </Section>
        </>
      ) : null}
    </div>
  );
}

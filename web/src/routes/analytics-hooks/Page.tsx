import { useMemo } from 'react';
import type { HarnessAnalyticsRow, HookAnalyticsRow } from '@core/types';
import { plural } from '@core/pricing/format';
import {
  CountCell,
  Duration,
  EmptyState,
  EstimateBadge,
  Kpi,
  LedgerTable,
  Money,
  Receipt,
  Skeleton,
  columnFractionDigits,
  type LedgerColumn,
  type ReceiptRow,
} from '@/components';
import { ShareBar } from '@/lib/bars';
import { useCurrency } from '@/lib/currency';
import { formatCount, formatPercent } from '@/lib/format';
import { attachmentTypeLabel, hookDisplayName, isUnnamedHook } from '@/lib/tools';
import { PageHeader, QueryError, Section } from '@/lib/page';
import { useHooksAnalytics } from '@/lib/queries';
import { useDateRange } from '@/lib/range';
import styles from './Page.module.css';

/** Every attributed column says once, at the top, that its money is an attribution. */
const ATTRIBUTED = (
  <EstimateBadge method="delta" detail="Attributed from the exact cost of the requests that carried this text." />
);

/** Hooks and harness injections: text you never wrote but still paid to send, plus the wall time. */
export default function HooksAnalyticsPage() {
  const range = useDateRange();
  const currency = useCurrency();
  const hooks = useHooksAnalytics(range.query);

  const hookRows = useMemo(() => [...(hooks.data?.hooks ?? [])].sort((a, b) => b.estCost - a.estCost), [hooks.data]);
  const harnessRows = useMemo(() => [...(hooks.data?.harness ?? [])].sort((a, b) => b.estCost - a.estCost), [hooks.data]);
  const totals = hooks.data?.totals;
  const harnessTotal = harnessRows.reduce((sum, row) => sum + row.estCost, 0);
  const overhead = (totals?.hookEstCost ?? 0) + (totals?.harnessEstCost ?? 0);

  const hookColumns = useMemo<LedgerColumn<HookAnalyticsRow>[]>(
    () => [
      {
        id: 'hook',
        header: 'Hook',
        width: '26%',
        sortValue: (row) => hookDisplayName(row),
        cell: (row) => {
          const name = hookDisplayName(row);
          const secondary = row.command ?? (isUnnamedHook(row.hookName) ? 'no command recorded' : row.hookEvent);
          return (
            <span className={styles.hookName}>
              <span className="truncate">{name}</span>
              {secondary && secondary !== name ? <span className={`${styles.hookMeta} truncate`}>{secondary}</span> : null}
            </span>
          );
        },
      },
      { id: 'runs', header: 'Runs', numeric: true, sortValue: (row) => row.runs, cell: (row) => formatCount(row.runs) },
      {
        id: 'failures',
        header: 'Failures',
        numeric: true,
        sortValue: (row) => row.failures,
        headerTitle: 'Runs that exited non-zero',
        cell: (row) => <CountCell value={row.failures} tone="cost" noun="failed runs" />,
      },
      {
        id: 'timeouts',
        header: 'Timeouts',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.timeouts,
        headerTitle: 'Runs the harness gave up waiting for',
        cell: (row) => <CountCell value={row.timeouts} noun="timed-out runs" />,
      },
      {
        id: 'totalDuration',
        header: 'Total time',
        numeric: true,
        sortValue: (row) => row.totalDurationMs,
        cell: (row) => <Duration ms={row.totalDurationMs} />,
      },
      {
        id: 'avgDuration',
        header: 'Avg time',
        numeric: true,
        sortValue: (row) => row.avgDurationMs,
        cell: (row) => <Duration ms={row.avgDurationMs} />,
      },
      {
        id: 'chars',
        header: 'Injected chars',
        numeric: true,
        secondary: true,
        headerTitle: 'Characters this hook put into the model context',
        sortValue: (row) => row.injectedChars,
        cell: (row) => formatCount(row.injectedChars),
      },
      {
        id: 'estCost',
        header: 'Cost',
        numeric: true,
        headerAside: ATTRIBUTED,
        headerTitle: 'Ingest and carry of the text this hook injected',
        sortValue: (row) => row.estCost,
        cell: (row) => <Money usd={row.estCost} currency={currency} />,
      },
    ],
    [currency],
  );

  const harnessColumns = useMemo<LedgerColumn<HarnessAnalyticsRow>[]>(
    () => [
      {
        id: 'type',
        header: 'Attachment type',
        width: '30%',
        sortValue: (row) => attachmentTypeLabel(row.attachmentType),
        cell: (row) => (
          <span className={styles.hookName}>
            <span className="truncate">{attachmentTypeLabel(row.attachmentType)}</span>
            <span className={`${styles.attachmentType} truncate`}>{row.attachmentType}</span>
          </span>
        ),
      },
      {
        id: 'occurrences',
        header: 'Occurrences',
        numeric: true,
        sortValue: (row) => row.occurrences,
        cell: (row) => formatCount(row.occurrences),
      },
      {
        id: 'chars',
        header: 'Rendered chars',
        numeric: true,
        secondary: true,
        headerTitle: 'Characters that actually entered the context',
        sortValue: (row) => row.chars,
        cell: (row) => formatCount(row.chars),
      },
      {
        id: 'share',
        header: 'Share',
        width: '14%',
        sortValue: (row) => row.estCost,
        cell: (row) => <ShareBar fraction={harnessTotal > 0 ? row.estCost / harnessTotal : 0} />,
        headerTitle: 'Share of harness overhead',
      },
      {
        id: 'sharePct',
        header: '%',
        numeric: true,
        headerTitle: 'Share of harness overhead',
        sortValue: (row) => row.estCost,
        cell: (row) => <span className="muted-2">{formatPercent(harnessTotal > 0 ? row.estCost / harnessTotal : 0)}</span>,
      },
      {
        id: 'estCost',
        header: 'Cost',
        numeric: true,
        headerAside: ATTRIBUTED,
        headerTitle: 'Ingest and carry of this attachment',
        sortValue: (row) => row.estCost,
        cell: (row) => <Money usd={row.estCost} currency={currency} />,
      },
    ],
    [currency, harnessTotal],
  );

  const totalRows = useMemo<ReceiptRow[]>(() => {
    const digits = columnFractionDigits([totals?.hookEstCost ?? 0, totals?.harnessEstCost ?? 0, overhead]) ?? 2;
    return [
      {
        id: 'hooks',
        label: 'Hook context',
        value: <Money usd={totals?.hookEstCost ?? 0} currency={currency} fractionDigits={digits} />,
        note: plural(hookRows.reduce((sum, row) => sum + row.runs, 0), 'run'),
      },
      {
        id: 'harness',
        label: 'Harness injections',
        value: <Money usd={totals?.harnessEstCost ?? 0} currency={currency} fractionDigits={digits} />,
        note: plural(harnessRows.length, 'attachment type'),
      },
      {
        id: 'overhead',
        label: 'Overhead total',
        value: <Money usd={overhead} currency={currency} fractionDigits={digits} display />,
        emphasis: 'total',
      },
      {
        id: 'time',
        label: 'Hook wall time',
        value: <Duration ms={totals?.hookDurationMs ?? 0} />,
        note: 'turns waited on a hook',
        emphasis: 'muted',
      },
    ];
  }, [totals, currency, hookRows, harnessRows, overhead]);

  if (range.provider === 'codex') {
    return <div className="stack"><PageHeader title="Hooks & harness" /><EmptyState title="Hook attribution unavailable for Codex" description="Codex rollouts do not record Claude Code hook or harness attribution. Missing records do not mean zero overhead." /></div>;
  }

  return (
    <div className={`stack stack-lg ${styles.page}`}>
      <PageHeader
        title="Hooks & harness"
        lead="Everything injected into the context that you did not type: hook output and the harness's own reminders, listings and notices."
      />

      {hooks.isError ? (
        <QueryError error={hooks.error} what="the hook analytics" onRetry={() => void hooks.refetch()} />
      ) : null}

      {hooks.isPending ? (
        <div className="stack" aria-busy="true">
          <Skeleton height={96} label="Loading hook analytics" />
          <Skeleton height={220} />
        </div>
      ) : null}

      {hooks.data && totals ? (
        <>
          <div className="grid-kpis">
            <Kpi
              label="Overhead"
              size="lg"
              value={<Money usd={overhead} currency={currency} display />}
              sub={<EstimateBadge method="delta" size="md" />}
              hint="Ingest and carry of hook output plus harness attachments, attributed from exact request costs."
            />
            <Kpi label="Hook context" value={<Money usd={totals.hookEstCost} currency={currency} display />} sub={plural(hookRows.length, 'hook')} />
            <Kpi
              label="Harness injections"
              value={<Money usd={totals.harnessEstCost} currency={currency} display />}
              sub={plural(harnessRows.length, 'type')}
            />
            <Kpi
              label="Hook wall time"
              value={<Duration ms={totals.hookDurationMs} />}
              sub="blocking turns"
              hint="Total recorded run time of every hook. It costs no tokens, but you waited for it."
            />
          </div>

          <Section title="Hooks" note="runs, failures and the text they injected">
            {hookRows.length === 0 ? (
              <EmptyState inline title="No hook ran in this range" icon="hook" />
            ) : (
              <LedgerTable
                columns={hookColumns}
                rows={hookRows}
                rowKey={(row) => `${row.hookName}:${row.hookEvent ?? ''}`}
                caption="Hook runs in the selected range"
                defaultSort={{ columnId: 'estCost', direction: 'desc' }}
                dense
              />
            )}
          </Section>

          <Section title="Harness attachments" note="what Claude Code adds to every conversation">
            <div className={styles.twoUp}>
              {harnessRows.length === 0 ? (
                <EmptyState inline title="No harness attachment in this range" icon="info" />
              ) : (
                <LedgerTable
                  columns={harnessColumns}
                  rows={harnessRows}
                  rowKey={(row) => row.attachmentType}
                  caption="Harness attachments in the selected range"
                  defaultSort={{ columnId: 'estCost', direction: 'desc' }}
                  maxHeight={harnessRows.length > 16 ? 520 : undefined}
                  dense
                />
              )}
              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3>Totals</h3>
                  <EstimateBadge method="delta" />
                </div>
                <Receipt rows={totalRows} />
              </div>
            </div>
          </Section>
        </>
      ) : null}
    </div>
  );
}

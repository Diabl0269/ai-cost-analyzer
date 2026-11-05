import { useMemo } from 'react';
import { useNavigate } from '@/lib/navigation';
import type { OverviewResponse } from '@core/types';
import { plural } from '@core/pricing/format.js';
import { LedgerTable, Money, type LedgerColumn } from '@/components';
import { ShareBar } from '@/lib/bars';
import type { CurrencyDisplay } from '@/lib/format';
import { formatCount, formatPercent } from '@/lib/format';
import styles from './Overview.module.css';

type ProjectRow = OverviewResponse['byProject'][number];

export interface ProjectSpendProps {
  rows: ProjectRow[];
  total: number;
  currency: CurrencyDisplay;
  /** current `from`/`to`, carried into the sessions link so the range survives the jump */
  range: { from?: string; to?: string };
}

/** Spend per project; activating a row opens the session list filtered to it. */
export function ProjectSpend({ rows, total, currency, range }: ProjectSpendProps) {
  const navigate = useNavigate();

  const open = (row: ProjectRow): void => {
    const params = new URLSearchParams({ project: row.project.id });
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    void navigate(`/sessions?${params.toString()}`);
  };

  const columns = useMemo<LedgerColumn<ProjectRow>[]>(
    () => [
      {
        id: 'project',
        header: 'Project',
        width: '40%',
        sortValue: (row) => row.project.displayName,
        cell: (row) => (
          <span>
            {row.project.displayName}
            {row.project.isWorktree ? <span className="muted-2"> · worktree</span> : null}
            <span className={`${styles.projectPath} truncate`}>{row.project.path}</span>
          </span>
        ),
      },
      {
        id: 'sessions',
        header: 'Sessions',
        numeric: true,
        headerTitle:
          'Sessions with at least one request in this range. Opening a row lists sessions that *started* in it, so the two counts can differ.',
        sortValue: (row) => row.sessions,
        cell: (row) => formatCount(row.sessions),
      },
      {
        id: 'requests',
        header: 'Requests',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.requests,
        cell: (row) => formatCount(row.requests),
      },
      {
        id: 'share',
        header: 'Share',
        width: '14%',
        sortValue: (row) => row.cost,
        cell: (row) => <ShareBar fraction={total > 0 ? row.cost / total : 0} />,
        headerTitle: 'Share of range spend',
      },
      // Its own narrow numeric column. Packed into the Cost cell, the percentage pushed every
      // dollar figure off the column's right edge and the footer total lined up under nothing.
      {
        id: 'sharePct',
        header: '%',
        numeric: true,
        width: '8%',
        sortValue: (row) => row.cost,
        headerTitle: 'Share of range spend',
        cell: (row) => formatPercent(total > 0 ? row.cost / total : 0),
      },
      {
        id: 'cost',
        header: 'Cost',
        numeric: true,
        sortValue: (row) => row.cost,
        cell: (row) => <Money usd={row.cost} currency={currency} />,
      },
    ],
    [currency, total],
  );

  return (
    <LedgerTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.project.id}
      caption="Spend by project in the selected range"
      defaultSort={{ columnId: 'cost', direction: 'desc' }}
      onActivateRow={open}
      maxHeight={rows.length > 10 ? 440 : undefined}
      empty="No project spent anything in this range."
      footer={[
        plural(rows.length, 'project'),
        formatCount(rows.reduce((sum, row) => sum + row.sessions, 0)),
        formatCount(rows.reduce((sum, row) => sum + row.requests, 0)),
        null,
        total > 0 ? formatPercent(1) : null,
        <Money key="total" usd={total} currency={currency} />,
      ]}
    />
  );
}

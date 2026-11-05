import { hasNoRecordedUsage } from '@/lib/usage';
import { providerLabel } from '@/lib/provider';
import { useMemo } from 'react';
import { useNavigate } from '@/lib/navigation';
import type { SessionSummary } from '@core/types';
import { Duration, LedgerTable, ModelChip, Money, RelativeTime, type LedgerColumn } from '@/components';
import type { CurrencyDisplay } from '@/lib/format';
import { formatCount } from '@/lib/format';

export interface TopSessionsProps {
  sessions: SessionSummary[];
  currency: CurrencyDisplay;
}

/** The most expensive sessions in range; a row opens the session detail page. */
export function TopSessions({ sessions, currency }: TopSessionsProps) {
  const navigate = useNavigate();

  const columns = useMemo<LedgerColumn<SessionSummary>[]>(
    () => [
      {
        id: 'title',
        header: 'Session',
        width: '38%',
        sortValue: (row) => row.title,
        cell: (row) => <span className="truncate">{providerLabel(row.provider)} · {row.title}</span>,
      },
      {
        id: 'project',
        header: 'Project',
        width: '16%',
        secondary: true,
        sortValue: (row) => row.projectPath,
        cell: (row) => <span className="truncate muted">{row.projectPath.split('/').pop() ?? row.projectPath}</span>,
      },
      {
        id: 'started',
        header: 'Started',
        secondary: true,
        sortValue: (row) => row.startedAt,
        cell: (row) => <RelativeTime value={row.startedAt} />,
      },
      {
        id: 'duration',
        header: 'Duration',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.durationMs,
        cell: (row) => <Duration ms={row.durationMs} />,
      },
      {
        id: 'models',
        header: 'Models',
        cell: (row) => (
          <span className="cluster" style={{ gap: 'var(--s1)' }}>
            {row.models.slice(0, 3).map((model) => (
              <ModelChip key={model} model={model} glyphOnly size="sm" />
            ))}
          </span>
        ),
      },
      { id: 'prompts', header: 'Prompts', numeric: true, sortValue: (row) => row.promptCount, cell: (row) => formatCount(row.promptCount) },
      {
        id: 'requests',
        header: 'Requests',
        numeric: true,
        sortValue: (row) => row.requestCount,
        cell: (row) => formatCount(row.requestCount),
      },
      {
        id: 'cost',
        header: 'Cost',
        numeric: true,
        sortValue: (row) => row.cost.total,
        cell: (row) => hasNoRecordedUsage(row) ? <span>Unavailable</span> : <Money usd={row.cost.total} currency={currency} />,
      },
    ],
    [currency],
  );

  return (
    <LedgerTable
      columns={columns}
      rows={sessions}
      rowKey={(row) => row.id}
      caption="Most expensive sessions in the selected range"
      defaultSort={{ columnId: 'cost', direction: 'desc' }}
      onActivateRow={(row) => void navigate(`/sessions/${row.id}`)}
      empty="No sessions in this range."
    />
  );
}

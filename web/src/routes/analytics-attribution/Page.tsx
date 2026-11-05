import { providerLabel } from '@/lib/provider';
import { useMemo } from 'react';
import type { AttributionAnalyticsResponse } from '@core/types';
import { plural } from '@core/pricing/format';
import { Callout, EmptyState, Kpi, LedgerTable, Money, Skeleton, type IconName, type LedgerColumn } from '@/components';
import { ShareBar } from '@/lib/bars';
import { useCurrency } from '@/lib/currency';
import type { CurrencyDisplay } from '@/lib/format';
import { formatCount, formatPercent } from '@/lib/format';
import { PageHeader, QueryError, Section } from '@/lib/page';
import { useAttributionAnalytics } from '@/lib/queries';
import { useDateRange } from '@/lib/range';
import styles from './Page.module.css';

interface CostRow {
  name: string;
  requests: number;
  cost: number;
  toolCalls?: number;
}

function costColumns(currency: CurrencyDisplay, total: number, label: string, withToolCalls: boolean): LedgerColumn<CostRow>[] {
  const columns: LedgerColumn<CostRow>[] = [
    {
      id: 'name',
      header: label,
      width: '38%',
      sortValue: (row) => row.name,
      cell: (row) => <span className={`${styles.name} truncate`}>{row.name}</span>,
    },
    { id: 'requests', header: 'Requests', numeric: true, sortValue: (row) => row.requests, cell: (row) => formatCount(row.requests) },
  ];
  if (withToolCalls) {
    columns.push({
      id: 'toolCalls',
      header: 'Tool calls',
      numeric: true,
      secondary: true,
      sortValue: (row) => row.toolCalls ?? 0,
      cell: (row) => formatCount(row.toolCalls ?? 0),
    });
  }
  columns.push(
    {
      id: 'share',
      header: 'Share',
      width: '16%',
      sortValue: (row) => row.cost,
      cell: (row) => <ShareBar fraction={total > 0 ? row.cost / total : 0} />,
      headerTitle: 'Share of this table',
    },
    // The percentage gets its own column: sharing a cell with the money left neither of them
    // aligned with the footer underneath.
    {
      id: 'sharePct',
      header: '%',
      numeric: true,
      headerTitle: 'Share of this table',
      sortValue: (row) => row.cost,
      cell: (row) => <span className="muted-2">{formatPercent(total > 0 ? row.cost / total : 0)}</span>,
    },
    {
      id: 'cost',
      header: 'Cost',
      numeric: true,
      sortValue: (row) => row.cost,
      cell: (row) => <Money usd={row.cost} currency={currency} />,
    },
  );
  return columns;
}

function CostTable({
  rows,
  currency,
  label,
  caption,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  withToolCalls = false,
}: {
  rows: CostRow[];
  currency: CurrencyDisplay;
  label: string;
  caption: string;
  emptyTitle: string;
  /** the second line: what would fill this table */
  emptyDescription: string;
  emptyIcon: IconName;
  withToolCalls?: boolean;
}) {
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  const columns = useMemo(() => costColumns(currency, total, label, withToolCalls), [currency, total, label, withToolCalls]);
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} icon={emptyIcon} />;
  return (
    <LedgerTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.name}
      caption={caption}
      defaultSort={{ columnId: 'cost', direction: 'desc' }}
      maxHeight={rows.length > 20 ? 580 : undefined}
      dense
      footer={[
        plural(rows.length, 'row'),
        formatCount(rows.reduce((sum, row) => sum + row.requests, 0)),
        ...(withToolCalls ? [formatCount(rows.reduce((sum, row) => sum + (row.toolCalls ?? 0), 0))] : []),
        null,
        formatPercent(total > 0 ? 1 : 0),
        <Money key="total" usd={total} currency={currency} />,
      ]}
    />
  );
}

/**
 * Where the spend attaches to the things you installed: skills, plugins, MCP servers and slash
 * commands. Requests carry these markers, so the money here is exact request cost, not attribution.
 */
export default function AttributionAnalyticsPage() {
  const range = useDateRange();
  const currency = useCurrency();
  const attribution = useAttributionAnalytics(range.query);

  const data: AttributionAnalyticsResponse | undefined = attribution.data;
  const skillCost = (data?.skills ?? []).reduce((sum, row) => sum + row.cost, 0);
  const pluginCost = (data?.plugins ?? []).reduce((sum, row) => sum + row.cost, 0);
  const mcpCost = (data?.mcpServers ?? []).reduce((sum, row) => sum + row.cost, 0);
  const commandUses = (data?.localCommands ?? []).reduce((sum, row) => sum + row.uses, 0);
  // Four KPIs reading $0.00, $0.00, $0.00 and 0 say one thing, and a row of empty numerals is a
  // worse way to say it than a sentence.
  const nothingInstalled = data !== undefined && skillCost === 0 && pluginCost === 0 && mcpCost === 0 && commandUses === 0;

  const commandColumns = useMemo<LedgerColumn<{ name: string; uses: number }>[]>(
    () => [
      {
        id: 'name',
        header: 'Command',
        width: '60%',
        sortValue: (row) => row.name,
        cell: (row) => <span className={styles.name}>{row.name}</span>,
      },
      { id: 'uses', header: 'Uses', numeric: true, sortValue: (row) => row.uses, cell: (row) => formatCount(row.uses) },
    ],
    [],
  );

  if ((range.provider === 'codex' || range.provider === 'copilot')) {
    return <div className="stack"><PageHeader title="Attribution" /><EmptyState title={`Attribution unavailable for ${providerLabel(range.provider)}`} description="These transcripts do not record Claude Code skills, workflows or harness attribution." /></div>;
  }

  return (
    <div className={`stack stack-lg ${styles.page}`}>
      <PageHeader
        title="Attribution"
        lead="Requests tagged with the skill, plugin or MCP server that was active when they ran. Exact request cost — one request can carry more than one tag, so the tables do not sum to the range total."
      />

      {attribution.isError ? (
        <QueryError error={attribution.error} what="the attribution analytics" onRetry={() => void attribution.refetch()} />
      ) : null}

      {attribution.isPending ? (
        <div className="stack" aria-busy="true">
          <Skeleton height={96} label="Loading attribution" />
          <Skeleton height={220} />
        </div>
      ) : null}

      {data ? (
        <>
          {nothingInstalled ? (
            <Callout tone="info" icon="workflow" title="Nothing installed was active in this range">
              No request in this window carried a skill, plugin, MCP server or slash command. Widen the range in the top
              bar, or install something — the tables below fill in as soon as one is used.
            </Callout>
          ) : (
            <div className="grid-kpis">
              <Kpi label="Skills" value={<Money usd={skillCost} currency={currency} display />} sub={`${plural(data.skills.length, 'skill')} used`} />
              <Kpi label="Plugins" value={<Money usd={pluginCost} currency={currency} display />} sub={`${plural(data.plugins.length, 'plugin')} used`} />
              <Kpi
                label="MCP servers"
                value={<Money usd={mcpCost} currency={currency} display />}
                sub={`${plural(data.mcpServers.length, 'server')} connected`}
              />
              <Kpi
                label="Slash commands"
                value={<span className="num-display">{formatCount(commandUses)}</span>}
                sub={`${plural(data.localCommands.length, 'distinct command')}`}
              />
            </div>
          )}

          <div className={styles.pair}>
            <Section title="Skills" note="requests that ran with a skill loaded">
              <CostTable
                rows={data.skills}
                currency={currency}
                label="Skill"
                caption="Cost per skill in the selected range"
                emptyTitle="No skill was used in this range"
                emptyDescription="A row appears here for every skill that was loaded when a request ran — yours, a plugin's, or one of Claude Code's own."
                emptyIcon="insight"
              />
            </Section>

            <Section title="Plugins" note="skills and commands installed from a plugin">
              <CostTable
                rows={data.plugins}
                currency={currency}
                label="Plugin"
                caption="Cost per plugin in the selected range"
                emptyTitle="No plugin was used in this range"
                emptyDescription="Installing a plugin and using one of its skills or commands puts it here, with the cost of the requests it was active for."
                emptyIcon="workflow"
              />
            </Section>
          </div>

          <Section title="MCP servers" note="requests that touched a connector">
            <CostTable
              rows={data.mcpServers}
              currency={currency}
              label="Server"
              caption="Cost per MCP server in the selected range"
              emptyTitle="No MCP server was used in this range"
              emptyDescription="Every configured server that answered a tool call lands here, with the requests that call was part of."
              emptyIcon="tools"
              withToolCalls
            />
          </Section>

          <Section title="Slash commands" note="local commands recorded in the transcript">
            <div className={styles.half}>
              {data.localCommands.length === 0 ? (
                <EmptyState
                  title="No slash command in this range"
                  description="Commands you type as /name are counted here, whether they come from this project, your home directory or a plugin."
                  icon="agent"
                />
              ) : (
                <LedgerTable
                  columns={commandColumns}
                  rows={data.localCommands}
                  rowKey={(row) => row.name}
                  caption="Slash command usage in the selected range"
                  defaultSort={{ columnId: 'uses', direction: 'desc' }}
                  maxHeight={data.localCommands.length > 20 ? 580 : undefined}
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

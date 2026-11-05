import { hasNoRecordedUsage } from '@/lib/usage';
import { useMemo, useState } from 'react';
import { useNavigate } from '@/lib/navigation';
import type { ToolCallCost } from '@core/types';
import { EmptyState } from '@/components/EmptyState';
import { EstimateBadge } from '@/components/EstimateBadge';
import { Icon } from '@/components/Icon';
import { LedgerTable, type LedgerColumn } from '@/components/LedgerTable';
import { Money } from '@/components/Money';
import { Tokens } from '@/components/Tokens';
import { Tooltip } from '@/components/Tooltip';
import { plural } from '@core/pricing/format.js';
import { EM_DASH, formatCount, formatTokensExact } from '@/lib/format';
import { useSessionContext } from '../context';
import { ToolName, transcriptHref } from './toolbits';
import styles from './Tools.module.css';

export default function ToolsTab() {
  const { id, detail } = useSessionContext();
  const noUsage = hasNoRecordedUsage(detail.summary);
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return detail.toolCalls
      .filter((call) => (needle ? call.name.toLowerCase().includes(needle) : true))
      .sort((a, b) => b.ownCost - a.ownCost);
  }, [detail.toolCalls, filter]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, call) => ({
          own: acc.own + call.ownCost,
          child: acc.child + (call.childCost ?? 0),
          result: acc.result + call.resultChars,
        }),
        { own: 0, child: 0, result: 0 },
      ),
    [rows],
  );

  const columns: LedgerColumn<ToolCallCost>[] = [
    {
      id: 'name',
      header: 'Tool',
      width: '190px',
      sortValue: (call) => call.name,
      cell: (call) => (
        <span className={styles.nameCell}>
          <ToolName name={call.name} {...(call.mcpServer ? { mcpServer: call.mcpServer } : {})} />
          {call.agentId ? (
            <Tooltip content="This call was made by a subagent, not the main transcript.">
              <span className={styles.agent}>
                <Icon name="agent" size={11} /> agent
              </span>
            </Tooltip>
          ) : null}
          {call.isError ? <span className={styles.error}>error</span> : null}
        </span>
      ),
    },
    {
      id: 'input',
      header: 'Input',
      width: '280px',
      cell: (call) => (
        // An explicit width on the cell content is what keeps `table-layout: auto` from
        // letting a long command push the money columns off the right edge.
        <span className={styles.input} title={call.inputSummary}>
          {call.inputSummary || EM_DASH}
        </span>
      ),
    },
    {
      id: 'turn',
      header: 'Turn',
      numeric: true,
      width: '56px',
      secondary: true,
      sortValue: (call) => call.turnIndex,
      cell: (call) => call.turnIndex,
    },
    {
      id: 'result',
      header: 'Result',
      numeric: true,
      width: '84px',
      sortValue: (call) => call.resultChars,
      cell: (call) => (
        <span className={styles.result} title={`${formatTokensExact(call.resultChars)} characters, shape: ${call.resultShape}`}>
          {call.resultSeq === undefined ? <span className={styles.muted}>none</span> : <Tokens value={call.resultChars} unit="ch" />}
        </span>
      ),
    },
    {
      id: 'gen',
      header: 'Gen',
      numeric: true,
      width: '78px',
      secondary: true,
      headerTitle: 'The share of the request’s output tokens spent writing this call',
      sortValue: (call) => call.genCost,
      cell: (call) => <Money usd={noUsage ? null : call.genCost} />,
    },
    {
      id: 'ingest',
      header: 'Ingest',
      numeric: true,
      width: '82px',
      secondary: true,
      headerTitle: 'What it cost to put the result into the context once',
      sortValue: (call) => call.result.ingestCost,
      cell: (call) => <Money usd={noUsage ? null : call.result.ingestCost} />,
    },
    {
      id: 'carry',
      header: 'Carry',
      numeric: true,
      width: '78px',
      headerTitle: 'What it cost to keep re-sending the result on every later request',
      sortValue: (call) => call.result.carryCost,
      cell: (call) => (
        <span title={`re-sent on ${plural(call.result.carryRequests, 'later request')}`}>
          <Money usd={noUsage ? null : call.result.carryCost} />
        </span>
      ),
    },
    {
      id: 'own',
      header: 'Own',
      numeric: true,
      width: '100px',
      sortValue: (call) => call.ownCost,
      cell: (call) => (
        <span className={styles.ownCell}>
          <Money usd={noUsage ? null : call.ownCost} className={styles.strong} />
          <EstimateBadge method={call.result.estMethod} />
        </span>
      ),
    },
    {
      id: 'child',
      header: 'Child',
      numeric: true,
      width: '86px',
      headerTitle: 'Exact cost of the subagent or workflow this call started — never folded into the session’s own total',
      sortValue: (call) => call.childCost ?? 0,
      cell: (call) => (call.childCost === null ? <span className={styles.muted}>{EM_DASH}</span> : <Money usd={noUsage ? null : call.childCost} />),
    },
  ];

  if (detail.toolCalls.length === 0) {
    return <EmptyState icon="tools" title="No tool call in this session" description="Every request in this session answered with text alone." />;
  }

  return (
    <div className="stack stack-sm">
      <div className="section-head">
        <h2>Tool calls</h2>
        <label className={styles.filter}>
          <span className="visually-hidden">Filter by tool name</span>
          <Icon name="filter" size={13} />
          <input
            type="search"
            value={filter}
            placeholder="Filter by tool name"
            onChange={(event) => setFilter(event.target.value)}
            className={styles.filterInput}
          />
        </label>
      </div>
      <LedgerTable
        columns={columns}
        rows={rows}
        rowKey={(call) => call.toolUseId}
        caption="Tool calls by own cost"
        dense
        maxHeight={640}
        defaultSort={{ columnId: 'own', direction: 'desc' }}
        onActivateRow={(call) => navigate(transcriptHref(id, call.agentId, call.requestSeq))}
        empty={`No tool matches “${filter}”.`}
        footer={[
          <span key="label" className={styles.muted}>
            {plural(rows.length, 'call')}
          </span>,
          null,
          null,
          <Tokens key="chars" value={totals.result} unit="ch" />,
          null,
          null,
          null,
          <Money key="own" usd={noUsage ? null : totals.own} className={styles.strong} />,
          <Money key="child" usd={noUsage ? null : totals.child} />,
        ]}
      />
      <p className={styles.legend}>
        Generate, ingest and carry are estimated <EstimateBadge method="delta" />; child costs are exact.
        Press Enter on a row to open it in the transcript.
      </p>
    </div>
  );
}

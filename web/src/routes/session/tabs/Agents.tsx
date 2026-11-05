import { useMemo } from 'react';
import { useNavigate } from '@/lib/navigation';
import type { AgentNode, WorkflowRunNode } from '@core/types';
import { Duration } from '@/components/Duration';
import { EmptyState } from '@/components/EmptyState';
import { Icon } from '@/components/Icon';
import { LedgerTable, type LedgerColumn } from '@/components/LedgerTable';
import { ModelChip } from '@/components/ModelChip';
import { Money } from '@/components/Money';
import { Tokens } from '@/components/Tokens';
import { Tooltip } from '@/components/Tooltip';
import { plural } from '@core/pricing/format.js';
import { formatCount } from '@/lib/format';
import { agentLabel, workflowRunLabel } from '../labels';
import { useSessionContext } from '../context';
import styles from './Agents.module.css';

type Row =
  | { kind: 'run'; key: string; depth: number; run: WorkflowRunNode }
  | { kind: 'agent'; key: string; depth: number; agent: AgentNode };

function walk(agents: AgentNode[], depth: number, out: Row[]): void {
  for (const agent of agents) {
    out.push({ kind: 'agent', key: agent.agentId, depth, agent });
    if (agent.children.length > 0) walk(agent.children, depth + 1, out);
  }
}

function durationOf(agent: AgentNode): number | null {
  if (!agent.startedAt || !agent.endedAt) return null;
  const ms = new Date(agent.endedAt).getTime() - new Date(agent.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function sumAgents(agents: AgentNode[]): { requests: number; tools: number; tokens: number } {
  return agents.reduce(
    (acc, agent) => {
      const child = sumAgents(agent.children);
      return {
        requests: acc.requests + agent.requestCount + child.requests,
        tools: acc.tools + agent.toolCallCount + child.tools,
        tokens: acc.tokens + agent.tokens.context + child.tokens,
      };
    },
    { requests: 0, tools: 0, tokens: 0 },
  );
}

export default function AgentsTab() {
  const { id, detail } = useSessionContext();
  const navigate = useNavigate();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const run of detail.workflowRuns) {
      out.push({ kind: 'run', key: `run:${run.runId}`, depth: 0, run });
      walk(run.agents, 1, out);
    }
    walk(detail.agents, 0, out);
    return out;
  }, [detail.agents, detail.workflowRuns]);

  const columns: LedgerColumn<Row>[] = [
    {
      id: 'agent',
      header: 'Agent',
      width: '340px',
      cell: (row) => (
        <span className={styles.nameCell} style={{ paddingLeft: `calc(var(--s4) * ${row.depth})` }}>
          {/* The nesting is indentation only, which a screen reader cannot see. This table is a
              tree flattened into rows, so each one states its own depth. */}
          <span className="visually-hidden">Level {row.depth + 1},</span>
          {row.kind === 'run' ? (
            <>
              <Icon name="workflow" size={13} className={styles.icon} />
              <span className={styles.runName}>{workflowRunLabel(row.run.runId)}</span>
              <span className={styles.note}>
                {plural(row.run.agentCount, 'agent')} · journal {row.run.journal.started}/{row.run.journal.result}
                {row.run.journal.failed > 0 ? <span className={styles.failed}> · {row.run.journal.failed} failed</span> : null}
              </span>
            </>
          ) : (
            <>
              <Icon name="agent" size={13} className={styles.icon} />
              <span className={styles.type}>{row.agent.agentType ?? 'agent'}</span>
              <span className={styles.note} title={agentLabel(row.agent)}>
                {row.agent.description ?? ''}
              </span>
            </>
          )}
        </span>
      ),
    },
    {
      id: 'model',
      header: 'Model',
      width: '150px',
      cell: (row) => {
        if (row.kind === 'run') return null;
        const { agent } = row;
        const requested = agent.requestedModel;
        const mismatch = requested && !agent.models.some((model) => model.includes(requested));
        return (
          <span className={styles.models}>
            {agent.models.map((model) => (
              <ModelChip key={model} model={model} />
            ))}
            {mismatch ? (
              <Tooltip content={`Requested “${requested}”, and these are the models that actually answered.`}>
                <span className={styles.requested}>asked: {requested}</span>
              </Tooltip>
            ) : null}
          </span>
        );
      },
    },
    {
      id: 'requests',
      header: 'Requests',
      numeric: true,
      width: '84px',
      cell: (row) => formatCount(row.kind === 'run' ? sumAgents(row.run.agents).requests : row.agent.requestCount),
    },
    {
      id: 'tools',
      header: 'Tools',
      numeric: true,
      width: '72px',
      secondary: true,
      cell: (row) => formatCount(row.kind === 'run' ? sumAgents(row.run.agents).tools : row.agent.toolCallCount),
    },
    {
      id: 'tokens',
      header: 'Context',
      numeric: true,
      width: '92px',
      secondary: true,
      headerTitle: 'Total tokens sent across this agent’s requests',
      cell: (row) => <Tokens value={row.kind === 'run' ? sumAgents(row.run.agents).tokens : row.agent.tokens.context} />,
    },
    {
      id: 'duration',
      header: 'Duration',
      numeric: true,
      width: '90px',
      cell: (row) => (row.kind === 'run' ? null : <Duration ms={durationOf(row.agent)} />),
    },
    {
      id: 'cost',
      header: 'Cost',
      numeric: true,
      width: '100px',
      cell: (row) => (
        <Money usd={row.kind === 'run' ? row.run.cost.total : row.agent.cost.total} className={styles.strong} />
      ),
    },
  ];

  if (detail.summary.provider === 'codex' && rows.length === 0) {
    return <EmptyState title="No linked agents recorded" description="No linked agent transcript was recorded for this rollout. Missing records do not mean no delegation occurred." />;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="agent"
        title="This session delegated nothing"
        description="No Agent or Workflow tool call, so every request belongs to the main transcript."
      />
    );
  }

  const total = detail.summary.costAgents + detail.summary.costWorkflows;

  return (
    <div className="stack stack-sm">
      <div className="section-head">
        <h2>Subagents and workflow runs</h2>
        <span className={styles.note}>Delegated work is priced separately and never folded into the main transcript.</span>
      </div>
      <LedgerTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        caption="Agents in this session"
        dense
        onActivateRow={(row) => {
          if (row.kind === 'agent') navigate(`/sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(row.agent.agentId)}`);
        }}
        footer={[
          <span key="l" className={styles.note}>
            {plural(rows.filter((row) => row.kind === 'agent').length, 'agent')}
          </span>,
          null,
          null,
          null,
          null,
          null,
          <Money key="c" usd={total} className={styles.strong} />,
        ]}
      />
      <p className={styles.note}>Press Enter on an agent to read its own transcript.</p>
    </div>
  );
}

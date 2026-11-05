import { useMemo } from 'react';
import { useParams } from 'react-router';
import { Link } from '@/lib/navigation';
import { plural } from '@core/pricing/format.js';
import type { AgentNode, SessionDetail } from '@core/types';
import { Callout } from '@/components/Callout';
import { Icon } from '@/components/Icon';
import { ModelChip } from '@/components/ModelChip';
import { Money } from '@/components/Money';
import { Tokens } from '@/components/Tokens';
import { formatCount } from '@/lib/format';
import { agentLabel, workflowRunLabel } from '../labels';
import { useSessionContext } from '../context';
import { TranscriptView } from '../transcript/TranscriptView';
import styles from './AgentTranscript.module.css';

function findAgent(detail: SessionDetail, agentId: string): { agent: AgentNode; runId?: string } | null {
  const walk = (agents: AgentNode[], runId?: string): { agent: AgentNode; runId?: string } | null => {
    for (const agent of agents) {
      if (agent.agentId === agentId) return runId === undefined ? { agent } : { agent, runId };
      const found = walk(agent.children, runId);
      if (found) return found;
    }
    return null;
  };
  for (const run of detail.workflowRuns) {
    const found = walk(run.agents, run.runId);
    if (found) return found;
  }
  return walk(detail.agents);
}

/** One subagent's own transcript, with a breadcrumb back to the agent tree. */
export default function AgentTranscriptTab() {
  const { id, detail, whatIf } = useSessionContext();
  const { agentId = '' } = useParams();
  const found = useMemo(() => findAgent(detail, agentId), [detail, agentId]);

  if (!found) {
    return (
      <Callout tone="warn" title="No such agent in this session">
        <Link to={`/sessions/${encodeURIComponent(id)}/agents`}>Back to the agent tree</Link>
      </Callout>
    );
  }

  const { agent, runId } = found;
  const heading = (
    <div className={styles.head}>
      <p className={styles.crumbs}>
        <Link to={`/sessions/${encodeURIComponent(id)}/agents`} className={styles.crumb}>
          <Icon name="chevron" size={11} rotate={180} /> Agents
        </Link>
        {runId ? <span className={styles.runId}>{workflowRunLabel(runId)}</span> : null}
      </p>
      <div className={styles.title}>
        <Icon name="agent" size={14} />
        <span className={styles.type}>{agent.agentType ?? 'agent'}</span>
        <span className={styles.description} title={agentLabel(agent)}>
          {agent.description ?? ''}
        </span>
      </div>
      <div className={styles.stats}>
        {agent.models.map((model) => (
          <ModelChip key={model} model={model} />
        ))}
        {agent.requestedModel ? <span className={styles.muted}>requested: {agent.requestedModel}</span> : null}
        <span className={styles.muted}>{plural(agent.requestCount, 'request')}</span>
        <span className={styles.muted}>{formatCount(agent.toolCallCount)} tool calls</span>
        <span className={styles.muted}>
          <Tokens value={agent.tokens.context} unit="tok" /> of context
        </span>
        <Money usd={agent.cost.total} className={styles.cost} />
      </div>
    </div>
  );

  return (
    <TranscriptView
      key={`${id}:${agentId}:${whatIf.param ?? ''}`}
      sessionId={id}
      agentId={agentId}
      detail={detail}
      whatIf={whatIf.param}
      heading={heading}
    />
  );
}

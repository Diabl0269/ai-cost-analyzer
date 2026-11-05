import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useNavigate } from '@/lib/navigation';
import type { AgentNode, WorkflowRunNode } from '@core/types';
import { Money } from '@/components/Money';
import { Skeleton } from '@/components/Skeleton';
import { TreeNav, type TreeNode } from '@/components/TreeNav';
import { useAgentTree } from '@/lib/queries';
import { agentLabel, workflowRunLabel } from './labels';
import { useWhatIf } from '@/lib/whatif';
import styles from './Rail.module.css';

function agentNode(agent: AgentNode): TreeNode {
  const label = agentLabel(agent);
  return {
    id: agent.agentId,
    label: (
      <span className={styles.node}>
        {/* The full brief goes in `title`: the rail is 264px and these run to 80 characters. */}
        <span className="truncate" title={label}>
          {label}
        </span>
      </span>
    ),
    text: label,
    icon: 'agent',
    meta: <Money usd={agent.cost.total} />,
    ...(agent.children.length > 0 ? { children: agent.children.map(agentNode) } : {}),
  };
}

function runNode(run: WorkflowRunNode): TreeNode {
  const label = workflowRunLabel(run.runId);
  return {
    id: `run:${run.runId}`,
    label: (
      <span className="truncate" title={label}>
        {label}
      </span>
    ),
    text: label,
    icon: 'workflow',
    meta: <Money usd={run.cost.total} />,
    ...(run.agents.length > 0 ? { children: run.agents.map(agentNode) } : {}),
  };
}

/**
 * The rail's "In this session" slot: every subagent and workflow run, priced, and one
 * click from its own transcript.
 */
export function SessionRail({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const whatIf = useWhatIf();
  const { agentId } = useParams();
  const tree = useAgentTree(sessionId, whatIf.param);

  const nodes = useMemo<TreeNode[]>(() => {
    const data = tree.data;
    if (!data) return [];
    return [...data.workflowRuns.map(runNode), ...data.agents.map(agentNode)];
  }, [tree.data]);

  if (tree.isPending) return <Skeleton lines={3} height={10} />;
  if (nodes.length === 0) return <p className={styles.empty}>This session delegated nothing — every request is in the main transcript.</p>;

  return (
    <TreeNav
      nodes={nodes}
      label="Subagents and workflow runs"
      dense
      selectedId={agentId ?? null}
      defaultExpandedIds={nodes.map((node) => node.id)}
      onSelect={(node) => {
        if (node.id.startsWith('run:')) return;
        navigate(`/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(node.id)}`);
      }}
    />
  );
}

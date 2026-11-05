import { hasNoRecordedUsage } from '@/lib/usage';
import { useMemo } from 'react';
import { Outlet, useLocation, useParams } from 'react-router';
import { Callout } from '@/components/Callout';
import { Money } from '@/components/Money';
import { Skeleton } from '@/components/Skeleton';
import { Tabs, type TabItem } from '@/components/Tabs';
import { useSession } from '@/lib/queries';
import { useRailSlot } from '@/app/shell/rail';
import { useWhatIf } from '@/lib/whatif';
import { ApiError } from '@/lib/api';
import type { SessionContextValue } from './context';
import { SessionHeader } from './Header';
import { SessionRail } from './Rail';
import styles from './Page.module.css';

const TAB_SEGMENTS = ['summary', 'transcript', 'tools', 'agents', 'hooks', 'timeline'] as const;

/**
 * Session detail shell: one fetch, one header, and the tab bar bound to the nested routes.
 * Tabs receive the loaded detail through the outlet context, so switching tabs is instant.
 */
export default function SessionPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const whatIf = useWhatIf();
  const detail = useSession(id, whatIf.param);

  const segment = location.pathname.split('/')[3] ?? 'summary';
  const active = (TAB_SEGMENTS as readonly string[]).includes(segment) ? segment : 'summary';

  useRailSlot(<SessionRail sessionId={id} />, [id]);

  const data = detail.data;
  const items = useMemo<TabItem[]>(() => {
    const base = `/sessions/${encodeURIComponent(id)}`;
    const counts: Partial<Record<(typeof TAB_SEGMENTS)[number], number>> = data
      ? {
          tools: data.toolCalls.length,
          agents: data.summary.agentCount + data.summary.workflowRunCount,
          hooks: data.hooks.length + data.injections.filter((injection) => injection.kind === 'attachment').length,
        }
      : {};
    return [
      { id: 'summary', label: 'Summary', to: `${base}/summary` },
      { id: 'transcript', label: 'Transcript', to: `${base}/transcript` },
      { id: 'tools', label: 'Tools', to: `${base}/tools`, ...(counts.tools ? { count: counts.tools } : {}) },
      { id: 'agents', label: 'Agents', to: `${base}/agents`, ...(counts.agents ? { count: counts.agents } : {}) },
      { id: 'hooks', label: 'Hooks & harness', to: `${base}/hooks`, ...(counts.hooks ? { count: counts.hooks } : {}) },
      { id: 'timeline', label: 'Timeline', to: `${base}/timeline` },
    ];
  }, [id, data]);

  if (detail.isPending) {
    return (
      <div className="stack">
        <Skeleton width="42%" height={30} />
        <Skeleton lines={3} height={12} />
        <Skeleton height={220} />
      </div>
    );
  }

  if (detail.isError || !data) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="stack">
        <h1>Session</h1>
        <Callout tone="warn" title={notFound ? 'No session with that id' : 'That session could not be loaded'}>
          {notFound
            ? 'Its source transcript may have been removed, or the index has not caught up yet.'
            : 'The index may still be building. Try again once indexing finishes.'}
        </Callout>
      </div>
    );
  }

  const context: SessionContextValue = { id, detail: data, whatIf };

  return (
    <div className="stack">
      <SessionHeader detail={data} whatIf={whatIf} />
      <div className={styles.tabRow}>
        {/* Navigation: nothing to click on paper. */}
        <div className={styles.tabsSlot} data-print-hide>
          <Tabs items={items} value={active} label="Session sections" />
        </div>
        <p className={styles.total}>
          <span className="eyebrow">Session total</span>
          {hasNoRecordedUsage(data.summary) ? <span>Unavailable</span> : <Money usd={data.summary.cost.total} display />}
        </p>
      </div>
      {whatIf.active ? (
        <Callout tone="info" title="Simulated prices">
          Every number on this page is priced with your substitutions, not the real table. Clear the
          simulation in “Simulating prices” to go back.
        </Callout>
      ) : null}
      <Outlet context={context} />
    </div>
  );
}

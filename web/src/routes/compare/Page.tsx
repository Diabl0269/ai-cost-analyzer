import { hasNoRecordedUsage } from '@/lib/usage';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { SessionDetail } from '@core/types';
import { EmptyState, LinkButton, Skeleton } from '@/components';
import { useCurrency } from '@/lib/currency';
import { PageHeader, QueryError, Section } from '@/lib/page';
import { useSession } from '@/lib/queries';
import { CompareTable, SessionPicker, type CompareRow } from './components';
import { harnessCost, hookCost, hookDuration, row, toolTotals } from './derive';
import styles from './Page.module.css';

/** Two sessions, one ledger: the same rows for each, plus what the second cost above the first. */
export default function ComparePage() {
  const [params, setParams] = useSearchParams();
  const currency = useCurrency();
  const idA = params.get('a');
  const idB = params.get('b');

  const setSide = useCallback(
    (side: 'a' | 'b', sessionId: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (sessionId) next.set(side, sessionId);
          else next.delete(side);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );

  const queryA = useSession(idA ?? undefined);
  const queryB = useSession(idB ?? undefined);
  const a: SessionDetail | null = queryA.data ?? null;
  const b: SessionDetail | null = queryB.data ?? null;
  const both = a !== null && b !== null;


  const headline = useMemo<CompareRow[]>(
    () => [
      row('cost', 'Total cost', 'money', (detail) => detail.summary.cost.total, a, b, { emphasis: 'total' }),
      row('requests', 'Requests', 'count', (detail) => detail.summary.requestCount, a, b),
      row('prompts', 'Prompts', 'count', (detail) => detail.summary.promptCount, a, b),
      row('costPerPrompt', 'Cost per prompt', 'money', (detail) =>
        detail.summary.promptCount > 0 ? detail.summary.cost.total / detail.summary.promptCount : 0, a, b),
      row('toolCalls', 'Tool calls', 'count', (detail) => detail.summary.toolCallCount, a, b),
      row('agents', 'Agents', 'count', (detail) => detail.summary.agentCount, a, b),
      row('compactions', 'Compactions', 'count', (detail) => detail.summary.compactionCount, a, b),
      row('context', 'Context tokens', 'tokens', (detail) => detail.summary.tokens.context, a, b),
      row('cacheHit', 'Cache hit ratio', 'percent', (detail) =>
        detail.summary.tokens.context > 0 ? detail.summary.tokens.cacheRead / detail.summary.tokens.context : 0, a, b),
      row('duration', 'Wall clock', 'duration', (detail) => detail.summary.durationMs, a, b),
    ],
    [a, b],
  );

  const categories = useMemo<CompareRow[]>(
    () => [
      row('output', 'Output', 'money', (detail) => detail.categories.exact.output, a, b),
      row('input', 'Input', 'money', (detail) => detail.categories.exact.input, a, b),
      row('cacheWrite', 'Cache write', 'money', (detail) => detail.categories.exact.cacheWrite, a, b),
      row('cacheRead', 'Cache read', 'money', (detail) => detail.categories.exact.cacheRead, a, b),
      row('webSearch', 'Web search', 'money', (detail) => detail.categories.exact.webSearch, a, b),
      row('total', 'Total', 'money', (detail) => detail.categories.exact.total, a, b, { emphasis: 'total' }),
    ],
    [a, b],
  );

  const estimated = useMemo<CompareRow[]>(
    () => [
      row('assistantOutput', 'Assistant output', 'money', (detail) => detail.categories.estimated.assistantOutput, a, b),
      row('prompts', 'Your prompts', 'money', (detail) => detail.categories.estimated.userPrompts, a, b),
      row('toolResults', 'Tool results', 'money', (detail) =>
        detail.categories.estimated.toolResultsByTool.reduce((sum, tool) => sum + tool.cost, 0), a, b),
      row('hooks', 'Hook context', 'money', hookCost, a, b),
      row('harness', 'Harness injections', 'money', harnessCost, a, b),
      row('compact', 'Compaction summaries', 'money', (detail) => detail.categories.estimated.compactSummaries, a, b),
      row('hookTime', 'Hook wall time', 'duration', hookDuration, a, b, { emphasis: 'muted' }),
    ],
    [a, b],
  );

  const delegation = useMemo<CompareRow[]>(
    () => [
      row('main', 'Main transcript', 'money', (detail) => detail.summary.costMain, a, b),
      row('agents', 'Subagents', 'money', (detail) => detail.summary.costAgents, a, b),
      row('workflows', 'Workflow runs', 'money', (detail) => detail.summary.costWorkflows, a, b),
      row('total', 'Total', 'money', (detail) => detail.summary.cost.total, a, b, { emphasis: 'total' }),
    ],
    [a, b],
  );

  const models = useMemo<CompareRow[]>(() => {
    if (!a && !b) return [];
    const labels = new Map<string, string>();
    for (const detail of [a, b]) {
      for (const model of detail?.byModel ?? []) labels.set(model.model, model.label);
    }
    const find = (detail: SessionDetail | null, model: string): number | null =>
      detail && !hasNoRecordedUsage(detail.summary) ? (detail.byModel.find((entry) => entry.model === model)?.cost.total ?? 0) : null;
    return [...labels.entries()]
      .map<CompareRow>(([model, label]) => ({ id: model, label, kind: 'money', a: find(a, model), b: find(b, model) }))
      .sort((first, second) => Math.max(second.a ?? 0, second.b ?? 0) - Math.max(first.a ?? 0, first.b ?? 0));
  }, [a, b]);

  const tools = useMemo<CompareRow[]>(() => {
    if (!a && !b) return [];
    const totalsA = toolTotals(a);
    const totalsB = toolTotals(b);
    const names = new Set([...totalsA.slice(0, 5).map((tool) => tool.name), ...totalsB.slice(0, 5).map((tool) => tool.name)]);
    return [...names]
      .map<CompareRow>((name) => {
        const inA = totalsA.find((tool) => tool.name === name);
        const inB = totalsB.find((tool) => tool.name === name);
        return {
          id: name,
          label: name,
          kind: 'money',
          a: a && !hasNoRecordedUsage(a.summary) ? (inA?.cost ?? 0) : null,
          b: b && !hasNoRecordedUsage(b.summary) ? (inB?.cost ?? 0) : null,
          note: `${inA?.calls ?? 0} / ${inB?.calls ?? 0} calls`,
        };
      })
      .sort((first, second) => Math.max(second.a ?? 0, second.b ?? 0) - Math.max(first.a ?? 0, first.b ?? 0));
  }, [a, b]);

  const failed = queryA.isError || queryB.isError;

  return (
    <div className={`stack stack-lg ${styles.page}`}>
      <PageHeader
        title="Compare sessions"
        lead="Pick two sessions and read them side by side. The URL carries both ids, so a comparison is a link you can keep."
        actions={
          <LinkButton to="/sessions" variant="ghost" size="sm">
            Browse sessions
          </LinkButton>
        }
      />

      <div className={styles.pickers}>
        <SessionPicker
          label="Session A"
          selectedId={idA}
          selected={a?.summary ?? null}
          onSelect={(sessionId) => setSide('a', sessionId)}
          currency={currency}
        />
        <SessionPicker
          label="Session B"
          selectedId={idB}
          selected={b?.summary ?? null}
          onSelect={(sessionId) => setSide('b', sessionId)}
          currency={currency}
        />
      </div>

      {failed ? (
        <QueryError
          error={queryA.error ?? queryB.error}
          what="one of the sessions"
          onRetry={() => {
            void queryA.refetch();
            void queryB.refetch();
          }}
        />
      ) : null}

      {(idA && queryA.isPending) || (idB && queryB.isPending) ? (
        <div className="stack" aria-busy="true">
          <Skeleton height={200} label="Loading the sessions" />
        </div>
      ) : null}

      {!idA || !idB ? (
        <EmptyState
          title="Choose two sessions"
          description="Search above, or open a session and use the compare action. Both ids live in the URL, so the result is shareable."
          icon="sessions"
        />
      ) : null}

      {a?.summary.usageIncomplete || b?.summary.usageIncomplete ? <p className="ui-sm muted" role="note">Usage is incomplete. Totals cover recorded tokens only; a dash means token usage or attribution is unavailable, not zero cost.</p> : null}
      {both ? (
        <>
          <p className={styles.legend}>
            <span>
              <strong>A</strong> {a.summary.title}
            </span>
            <span>
              <strong>B</strong> {b.summary.title}
            </span>
          </p>

          <Section title="Headline" note="recorded usage; Codex amounts are API-price estimates">
            <CompareTable rows={headline} caption="Headline metrics for both sessions" labelA="A" labelB="B" currency={currency} />
          </Section>

          <Section title="By token class" note="recorded usage priced at API list rates">
            <CompareTable rows={categories} caption="API list-price cost by token class" labelA="A" labelB="B" currency={currency} />
          </Section>

          <Section title="Where the money went" note="estimated attribution of the same money">
            <CompareTable rows={estimated} caption="Estimated cost by what filled the context" labelA="A" labelB="B" currency={currency} />
          </Section>

          <Section title="Main, agents and workflows" note="recorded usage priced at API list rates">
            <CompareTable rows={delegation} caption="Cost of the main transcript versus delegated work" labelA="A" labelB="B" currency={currency} />
          </Section>

          <Section title="By model" note="recorded usage priced at API list rates">
            <CompareTable rows={models} caption="Cost per model in both sessions" labelA="A" labelB="B" currency={currency} />
          </Section>

          <Section title="Top tools" note="the five heaviest in each session, estimated">
            <CompareTable rows={tools} caption="Cost per tool in both sessions" labelA="A" labelB="B" currency={currency} />
          </Section>
        </>
      ) : null}
    </div>
  );
}

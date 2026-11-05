import { useMemo } from 'react';
import { Link } from '@/lib/navigation';
import type { Insight } from '@core/types';
import { EmptyState, Kpi, Money, Skeleton } from '@/components';
import { useCurrency } from '@/lib/currency';
import { formatCount, formatDate } from '@/lib/format';
import { PageHeader, QueryError, Section } from '@/lib/page';
import { useInsights, useStatus } from '@/lib/queries';
import { formatRangeSentence, useDateRange } from '@/lib/range';
import { InsightCard } from './components';
import styles from './Page.module.css';

const GROUPS: { kind: Insight['kind']; title: string; note: string }[] = [
  { kind: 'saving', title: 'Savings available', note: 'price swaps that would have cost less for the same tokens' },
  { kind: 'waste', title: 'Where money leaked', note: 'spend that bought context rather than answers' },
  { kind: 'info', title: 'Worth knowing', note: 'shape of the spend, with no single lever' },
];

/** Ranked findings from `core/cost/insights.ts`, grouped by kind and sorted by money impact. */
export default function InsightsPage() {
  const range = useDateRange();
  const currency = useCurrency();
  const insights = useInsights(range.query);
  // Findings are recomputed per request, so their freshness is the index's freshness — the one
  // question this page used to leave the reader guessing at ("is this a report someone ran?").
  const status = useStatus();
  const lastIndexedAt = status.data?.lastIndexedAt ?? null;

  const grouped = useMemo(() => {
    const all = [...(insights.data?.insights ?? [])].sort((a, b) => b.impactUsd - a.impactUsd);
    return GROUPS.map((group) => ({ ...group, items: all.filter((insight) => insight.kind === group.kind) }));
  }, [insights.data]);

  const totals = useMemo(() => {
    const all = insights.data?.insights ?? [];
    const sum = (kind: Insight['kind']) =>
      all.filter((insight) => insight.kind === kind).reduce((acc, insight) => acc + insight.impactUsd, 0);
    return { saving: sum('saving'), waste: sum('waste'), count: all.length };
  }, [insights.data]);

  const resolved = insights.data?.range;

  return (
    <div className={`stack stack-lg ${styles.page}`}>
      <PageHeader
        title="Insights"
        lead={
          <>
            {/* `formatRangeSentence` is the one way this app names a window in prose, so the
                insights page and the overview print the same dates in the same shape. */}
            {resolved
              ? `Every finding the cost engine can make for ${formatRangeSentence(resolved.from, resolved.to)}, ranked by the money at stake.`
              : 'Every finding the cost engine can make for the selected range, ranked by the money at stake.'}{' '}
            <span className="muted-2">
              Computed live for this range from the index — nothing to run.{' '}
              <Link to="/how-it-works" className={styles.hintLink}>
                How it works
              </Link>
              {lastIndexedAt ? ` · Index up to date as of ${formatDate(lastIndexedAt, 'time')}` : null}
            </span>
          </>
        }
      />

      {insights.isError ? (
        <QueryError error={insights.error} what="the insights" onRetry={() => void insights.refetch()} />
      ) : null}

      {insights.isPending ? (
        <div className="stack" aria-busy="true">
          <Skeleton height={72} label="Loading insights" />
          <Skeleton height={132} />
          <Skeleton height={132} />
        </div>
      ) : null}

      {insights.data ? (
        <>
          <div className="grid-kpis">
            <Kpi
              label="Findings"
              value={<span className="num-display">{formatCount(totals.count)}</span>}
              sub="in this range"
            />
            <Kpi
              label="Savings available"
              value={<Money usd={totals.saving} currency={currency} display tone="save" />}
              hint="Sum of the price-swap findings. Token counts would differ in practice; these are list-price comparisons only."
            />
            <Kpi
              label="Identified waste"
              value={<Money usd={totals.waste} currency={currency} display tone="cost" />}
              hint="Spend the findings attribute to context that was re-sent, re-written or injected rather than to answers."
            />
          </div>

          {totals.count === 0 ? (
            <EmptyState
              title="No findings for this range"
              description="Widen the date range, or index more sessions — the engine needs a few requests before it can say anything useful."
              icon="insight"
            />
          ) : null}

          {grouped
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <Section key={group.kind} id={group.kind} title={group.title} note={group.note}>
                <ul className={styles.list}>
                  {group.items.map((insight) => (
                    <li key={insight.id}>
                      <InsightCard insight={insight} currency={currency} maxSessions={4} />
                    </li>
                  ))}
                </ul>
              </Section>
            ))}
        </>
      ) : null}
    </div>
  );
}

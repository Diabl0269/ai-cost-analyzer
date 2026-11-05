import { useMemo } from 'react';
import { Link } from '@/lib/navigation';
import type { BudgetStatus, PlanComparison } from '@core/types';
import { Callout, LedgerTable, Money, PlanGauge, type LedgerColumn } from '@/components';
import type { CurrencyDisplay } from '@/lib/format';
import { formatDate } from '@/lib/format';
import styles from './Overview.module.css';
import { useDateRange } from '@/lib/range';

type MonthRow = PlanComparison['months'][number];

export interface PlanPanelProps {
  plan: PlanComparison;
  budget: BudgetStatus;
  currency: CurrencyDisplay;
}

/**
 * Subscription vs pay-per-token, per calendar month (SPEC §10.1). The gauge shows the current
 * month; the table shows every month the range touches.
 *
 * With no plan configured there is nothing to compare against, so neither appears: a gauge
 * against `$0` and a table whose "Difference" column reads `+$265.65` in red are both statements
 * about an unanswered setting, not about spend. Until a plan is picked the panel states the
 * pay-per-token figure and asks for the missing one.
 */
export function PlanPanel({ plan, budget, currency }: PlanPanelProps) {
  const range = useDateRange();
  const current = useMemo(
    () => plan.months.find((month) => month.month === budget.month) ?? plan.months[plan.months.length - 1] ?? null,
    [plan.months, budget.month],
  );

  const columns = useMemo<LedgerColumn<MonthRow>[]>(
    () => [
      { id: 'month', header: 'Month', sortValue: (row) => row.month, cell: (row) => formatDate(`${row.month}-01`, 'month') },
      {
        id: 'api',
        header: 'Pay-per-token',
        numeric: true,
        sortValue: (row) => row.apiCost,
        cell: (row) => <Money usd={row.apiCost} currency={currency} />,
      },
      {
        id: 'plan',
        header: 'Subscription',
        numeric: true,
        sortValue: (row) => row.planCost,
        cell: (row) => <Money usd={row.planCost} currency={currency} />,
      },
      {
        id: 'delta',
        header: 'Difference',
        numeric: true,
        sortValue: (row) => row.delta,
        headerTitle: 'Pay-per-token minus subscription: positive means the API bill would be higher',
        cell: (row) => <Money usd={row.delta} currency={currency} delta tone="auto" />,
      },
    ],
    [currency],
  );

  if (range.provider !== 'claude') {
    return <Callout tone="info" title="Subscription comparison is for Claude">Select Claude to compare its API list-price usage with a configured Claude plan. Codex totals are API-price estimates, not subscription charges.</Callout>;
  }

  if (plan.preset === 'none') {
    const soFar = plan.months.reduce((sum, month) => sum + month.apiCost, 0);
    return (
      <div className={styles.planEmpty}>
        <Callout tone="info" title="No subscription configured" action={<Link to="/settings#plan">Choose a plan</Link>}>
          Pick the plan you are on in Settings and this becomes a like-for-like comparison against your API list-price
          spend.
        </Callout>
        <p className={styles.planSoFar}>
          <span className="eyebrow">Pay-per-token so far</span>
          <Money usd={soFar} currency={currency} display tone="none" />
          <span className="ui-xs muted-2">
            {plan.months.length > 0
              ? `across ${formatDate(`${plan.months[0]?.month ?? budget.month}-01`, 'month')} – ${formatDate(
                  `${plan.months[plan.months.length - 1]?.month ?? budget.month}-01`,
                  'month',
                )}`
              : 'in the selected range'}
          </span>
        </p>
      </div>
    );
  }

  return (
    <div className={styles.planGrid}>
      <div className="stack">
        {current ? (
          <PlanGauge
            planLabel={plan.label}
            planUsd={plan.monthlyUsd}
            apiUsd={current.apiCost}
            forecastUsd={current.month === budget.month ? budget.forecast : undefined}
            month={current.month}
          />
        ) : null}
      </div>
      <LedgerTable
        columns={columns}
        rows={plan.months}
        rowKey={(row) => row.month}
        caption="Pay-per-token versus subscription by calendar month"
        defaultSort={{ columnId: 'month', direction: 'desc' }}
        empty="No complete month in this range yet."
        dense
      />
    </div>
  );
}

import { Link } from '@/lib/navigation';
import type { BudgetStatus } from '@core/types';
import { plural } from '@core/pricing/format.js';
import { Callout, Money } from '@/components';
import type { CurrencyDisplay } from '@/lib/format';
import { formatCount, formatDate, formatPercent } from '@/lib/format';
import styles from './Overview.module.css';

export interface BudgetPanelProps {
  budget: BudgetStatus;
  currency: CurrencyDisplay;
}

/**
 * Monthly budget with a linear run-rate forecast (SPEC §10.2). The bar is decorative — every
 * number it encodes is written out beside it.
 */
export function BudgetPanel({ budget, currency }: BudgetPanelProps) {
  const limit = budget.monthlyBudgetUsd;

  if (limit === null || limit <= 0) {
    return (
      <Callout tone="info" title="No monthly budget set" action={<Link to="/settings#budget">Set a budget</Link>}>
        {`So far in ${formatDate(`${budget.month}-01`, 'month')} you have spent `}
        <Money usd={budget.spent} currency={currency} />
        {` over ${formatCount(budget.daysElapsed)} of ${plural(budget.daysInMonth, 'day')}, which runs to `}
        <Money usd={budget.forecast} currency={currency} />
        {' by month end at the current rate.'}
      </Callout>
    );
  }

  const spentShare = Math.min(1, budget.spent / limit);
  const forecastShare = Math.min(1, budget.forecast / limit);
  const over = budget.spent > limit;
  const forecastOver = budget.forecast > limit;

  return (
    <div className={styles.budget}>
      <div className="cluster cluster-between">
        <span className="eyebrow">{formatDate(`${budget.month}-01`, 'month')} budget</span>
        <span className="ui-sm">
          <Money usd={budget.spent} currency={currency} tone={over ? 'cost' : 'none'} /> of{' '}
          <Money usd={limit} currency={currency} /> · {formatPercent(budget.spent / limit)}
        </span>
      </div>
      <div className={styles.budgetTrack} aria-hidden="true">
        <span
          className={[styles.budgetSpent, over ? styles.budgetOver : null].filter(Boolean).join(' ')}
          style={{ width: `${spentShare * 100}%` }}
        />
        <span className={styles.budgetForecast} style={{ left: `${forecastShare * 100}%` }} />
      </div>
      <p className={styles.budgetLegend}>
        <span>
          {`Day ${formatCount(budget.daysElapsed)} of ${formatCount(budget.daysInMonth)}`}
        </span>
        <span>
          {'Forecast '}
          <Money usd={budget.forecast} currency={currency} tone={forecastOver ? 'cost' : 'save'} />
          {forecastOver ? (
            <>
              {' — '}
              <Money usd={budget.forecast - limit} currency={currency} delta tone="cost" /> over budget
            </>
          ) : (
            <>
              {' — '}
              <Money usd={limit - budget.forecast} currency={currency} tone="save" /> to spare
            </>
          )}
        </span>
      </p>
    </div>
  );
}

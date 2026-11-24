/**
 * Subscription comparison and budget forecast (SPEC §10.1, §10.2).
 * Dates are local calendar dates (`YYYY-MM-DD`), matching how the DB stores them.
 */
import type { BudgetStatus, PlanComparison, Provider, UserSettings } from '../types.js';

/** Minimal shape shared with `DailyPoint`. */
export interface DailyCost {
  date: string;
  cost: number;
}

export function monthKeyOf(localDate: string): string {
  return localDate.slice(0, 7);
}

export function localDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * API spend vs the configured plan, per calendar month.
 * `delta > 0` means the API bill would have been more expensive than the subscription.
 */
export function planComparison(dailyCosts: readonly DailyCost[], settings: UserSettings): PlanComparison {
  const byMonth = new Map<string, number>();
  for (const point of dailyCosts) {
    if (!point.date) continue;
    const key = monthKeyOf(point.date);
    byMonth.set(key, (byMonth.get(key) ?? 0) + point.cost);
  }
  const planCost = settings.plan.monthlyUsd;
  const months = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([month, apiCost]) => ({ month, apiCost, planCost, delta: apiCost - planCost }));
  return {
    preset: settings.plan.preset,
    label: settings.plan.label,
    monthlyUsd: planCost,
    months,
  };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export interface BudgetStatusExtras {
  providers?: Provider[];
  spentByProvider?: Partial<Record<Provider, number>>;
  providerBudgets?: Partial<Record<Provider, number>>;
}

/**
 * Spend so far this calendar month plus a linear run-rate forecast for month end.
 * `now` is injectable so tests do not depend on the wall clock.
 */
export function budgetStatus(
  dailyCosts: readonly DailyCost[],
  settings: UserSettings,
  now: Date,
  extras?: BudgetStatusExtras,
): BudgetStatus {
  const month = localDateKey(now).slice(0, 7);
  let spent = 0;
  for (const point of dailyCosts) {
    if (point.date.startsWith(month)) spent += point.cost;
  }
  const elapsed = now.getDate();
  const total = daysInMonth(now.getFullYear(), now.getMonth());
  return {
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
    month,
    spent,
    forecast: elapsed > 0 ? (spent / elapsed) * total : spent,
    daysElapsed: elapsed,
    daysInMonth: total,
    ...(extras?.providers ? { providers: extras.providers } : {}),
    ...(extras?.spentByProvider ? { spentByProvider: extras.spentByProvider } : {}),
    ...(extras?.providerBudgets && Object.keys(extras.providerBudgets).length > 0
      ? { providerBudgets: extras.providerBudgets }
      : {}),
  };
}

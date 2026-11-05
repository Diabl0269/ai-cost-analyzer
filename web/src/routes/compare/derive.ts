import { hasNoRecordedUsage } from '@/lib/usage';
import type { SessionDetail } from '@core/types';
import type { CompareRow } from './components';

/** Estimated harness overhead for a session: every non-hook, non-prompt injection. */
export function harnessCost(detail: SessionDetail): number {
  return detail.injections
    .filter((injection) => injection.kind === 'attachment' || injection.kind === 'system_prompt' || injection.kind === 'other')
    .reduce((sum, injection) => sum + injection.cost.ingestCost + injection.cost.carryCost, 0);
}

export function hookCost(detail: SessionDetail): number {
  return detail.hooks.reduce((sum, hook) => sum + hook.estCost, 0);
}

export function hookDuration(detail: SessionDetail): number {
  return detail.hooks.reduce((sum, hook) => sum + (hook.durationMs ?? 0), 0);
}

export interface ToolTotal {
  name: string;
  calls: number;
  cost: number;
}

/** Own cost per tool (generation + ingest + carry), heaviest first. Child cost is never folded in. */
export function toolTotals(detail: SessionDetail | null): ToolTotal[] {
  const totals = new Map<string, ToolTotal>();
  for (const call of detail?.toolCalls ?? []) {
    const existing = totals.get(call.name) ?? { name: call.name, calls: 0, cost: 0 };
    existing.calls += 1;
    existing.cost += call.ownCost;
    totals.set(call.name, existing);
  }
  return [...totals.values()].sort((a, b) => b.cost - a.cost);
}

type Pick = (detail: SessionDetail) => number;

/** Builds one comparison row from a metric both sessions expose. */
export function row(
  id: string,
  label: string,
  kind: CompareRow['kind'],
  pick: Pick,
  a: SessionDetail | null,
  b: SessionDetail | null,
  options: { note?: string; emphasis?: CompareRow['emphasis'] } = {},
): CompareRow {
  const value = (detail: SessionDetail | null): number | null => {
    if (!detail) return null;
    if (hasNoRecordedUsage(detail.summary) && ['money', 'tokens', 'percent'].includes(kind)) return null;
    if (detail.summary.provider === 'codex' && ['workflows', 'hooks', 'harness', 'hookTime'].includes(id)) return null;
    return pick(detail);
  };
  return {
    id,
    label,
    kind,
    a: value(a),
    b: value(b),
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.emphasis === undefined ? {} : { emphasis: options.emphasis }),
  };
}

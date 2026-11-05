/**
 * Receipt construction, shared by the Summary tab and the "copy as Markdown" action so the
 * clipboard and the screen can never disagree.
 */
import { plural } from '@core/pricing/format.js';
import type { CostBreakdown, SessionDetail } from '@core/types';
import type { ReceiptRow } from '@/components/Receipt';
import { shortToolLabel } from '@/lib/tools';
import { formatCount, formatDate, formatDuration, formatMoney, formatPercent, formatTokensExact } from '@/lib/format';
import { idleGaps } from './gaps';

export interface LabelledAmount {
  id: string;
  label: string;
  amount: number;
}

/** The exact split — every number here comes straight from API usage counts. */
export function exactAmounts(cost: CostBreakdown): LabelledAmount[] {
  return [
    { id: 'output', label: 'Output tokens', amount: cost.output },
    { id: 'input', label: 'Input tokens', amount: cost.input },
    { id: 'cacheWrite', label: 'Cache writes', amount: cost.cacheWrite },
    { id: 'cacheRead', label: 'Cache reads', amount: cost.cacheRead },
    { id: 'webSearch', label: 'Web search', amount: cost.webSearch },
  ];
}

/** Main transcript vs delegated work. Child costs are never folded into the parent. */
export function delegationAmounts(detail: SessionDetail): LabelledAmount[] {
  const { summary } = detail;
  if (summary.provider === 'codex') return [{ id: 'main', label: 'Recorded transcript (delegation attribution unavailable)', amount: summary.costMain }];
  return [
    { id: 'main', label: 'This transcript', amount: summary.costMain },
    { id: 'agents', label: `Subagents (${formatCount(summary.agentCount)})`, amount: summary.costAgents },
    { id: 'workflows', label: `Workflow runs (${formatCount(summary.workflowRunCount)})`, amount: summary.costWorkflows },
  ];
}

/** Same shape as `core/parse/tools.ts`: `mcp__<server>__<tool>`. */

/**
 * The estimate now names two categories that used to hide inside the residual: the assistant's
 * own earlier replies re-sent as history, and the baseline context every request carries.
 * Kept here so the receipts, their tooltips and the Markdown copy read the same sentence.
 */
export const ESTIMATE_DETAIL =
  'The split also prices the assistant’s earlier replies re-sent as conversation history and the baseline context — system prompt, tool definitions, memory and skill listings — that every request carries from the first one on.';

/** Rows whose amount is attributed rather than measured, so they carry their own “est.” badge. */
export const ESTIMATED_CONTEXT_IDS: ReadonlySet<string> = new Set(['baseline', 'assistantHistory']);

/** The estimated split of what filled the context, in the order the context is built (SPEC §5.3). */
export function estimatedAmounts(detail: SessionDetail, toolLimit = 8): LabelledAmount[] {
  const est = detail.categories.estimated;
  const tools = [...est.toolResultsByTool].sort((a, b) => b.cost - a.cost);
  const shown = tools.slice(0, toolLimit);
  const rest = tools.slice(toolLimit).reduce((sum, tool) => sum + tool.cost, 0);
  return [
    { id: 'baseline', label: 'Baseline context (system prompt, tools, memory)', amount: est.baseline ?? 0 },
    { id: 'assistantOutput', label: 'Assistant output', amount: est.assistantOutput },
    { id: 'userPrompts', label: 'Your prompts', amount: est.userPrompts },
    ...shown.map((tool) => ({
      id: `tool:${tool.name}`,
      label: `${shortToolLabel(tool.name)} results (${formatCount(tool.calls)})`,
      amount: tool.cost,
    })),
    ...(rest > 0 ? [{ id: 'tool:rest', label: `${tools.length - shown.length} other tools`, amount: rest }] : []),
    { id: 'assistantHistory', label: 'Assistant replies re-sent as history', amount: est.assistantHistory ?? 0 },
    { id: 'hooks', label: 'Hook output', amount: est.hooks },
    { id: 'harness', label: 'Harness injections', amount: est.harness },
    { id: 'systemPrompt', label: 'System prompt', amount: est.systemPrompt },
    { id: 'compactSummaries', label: 'Compaction summaries', amount: est.compactSummaries },
    { id: 'other', label: 'Other context', amount: est.other },
  ].filter((row) => row.amount > 0);
}

export interface ResidualAmount extends LabelledAmount {
  /** true when the split placed more money than the session actually cost */
  overshoot: boolean;
}

/**
 * What the split failed to place, reconciling the estimated rows back to the exact total. It is
 * shown rather than folded into a category so the guessed share stays visible; a negative residual
 * means the estimate overshot and is labelled as such (docs/METHODOLOGY.md §3).
 */
export function estimatedResidual(detail: SessionDetail, toolLimit = 8): ResidualAmount {
  const attributed = estimatedAmounts(detail, toolLimit).reduce((sum, row) => sum + row.amount, 0);
  const residual = detail.summary.cost.total - attributed;
  const overshoot = residual < 0;
  return {
    id: 'residual',
    label: overshoot ? 'Estimation overshoot' : 'Not attributed',
    amount: residual,
    overshoot,
  };
}

/** The one-line explanation of the residual row, shared by the receipt and its Markdown copy. */
export const RESIDUAL_EXPLANATION =
  'Attribution places every context token it can see in exactly one row; what the transcript never recorded — a tool result written to a file, an attachment with no rendered text, a forked parent conversation — is left here instead of being folded into a category. A negative figure means the token estimates overshot the context they were scaled to.';

/** A category has to hold more than this share of the bill before it earns the verdict line. */
const DRIVER_SHARE = 0.5;

/**
 * One sentence naming what actually drove the bill, or `null` when no single token class holds
 * more than half of it. The share comes from the exact receipt; the clause after the dash is the
 * mechanism — idle gaps, a compaction, a cold cache — so the reader knows what to change.
 */
export function costDriver(detail: SessionDetail): string | null {
  const { summary } = detail;
  const total = summary.cost.total;
  if (!(total > 0)) return null;
  const candidates = [
    { id: 'output', amount: summary.cost.output },
    { id: 'cacheWrite', amount: summary.cost.cacheWrite },
    { id: 'cacheRead', amount: summary.cost.cacheRead },
    { id: 'input', amount: summary.cost.input },
  ] as const;
  const top = candidates.reduce((best, candidate) => (candidate.amount > best.amount ? candidate : best));
  const share = top.amount / total;
  if (share <= DRIVER_SHARE) return null;
  const percent = formatPercent(share, 0);

  switch (top.id) {
    case 'output': {
      const outputTokens = detail.byModel.reduce((sum, row) => sum + row.tokens.output, 0);
      return `Generating answers was ${percent} of this session — ${plural(summary.requestCount, 'request')} produced ${formatTokensExact(outputTokens)} output tokens.`;
    }
    case 'cacheWrite': {
      const gaps = idleGaps(detail.requests);
      const cause =
        gaps.length > 0
          ? `${plural(gaps.length, 'idle gap')} over five minutes re-warmed the cache`
          : detail.compactions.length > 0
            ? `${plural(detail.compactions.length, 'compaction')} rebuilt the context from scratch`
            : 'the context kept changing, so every request wrote a fresh prefix';
      return `Cache writes were ${percent} of this session — ${cause}.`;
    }
    case 'cacheRead': {
      const reads = detail.requests.filter((request) => request.usage.cacheRead > 0).length;
      return `Cache reads were ${percent} of this session — the context was re-read ${plural(reads, 'time')} at a tenth of the input price, which is the cheap way to pay for it.`;
    }
    case 'input': {
      const cold = detail.requests.filter((request) => request.coldCache).length;
      return cold > 0
        ? `Fresh input was ${percent} of this session — ${plural(cold, 'request')} found no cache to read and paid full price for the whole prompt.`
        : `Fresh input was ${percent} of this session — the prompts themselves, not the context around them.`;
    }
  }
}

export function toReceiptRows(amounts: LabelledAmount[], render: (amount: number) => ReceiptRow['value']): ReceiptRow[] {
  return amounts.map((amount) => ({ id: amount.id, label: amount.label, value: render(amount.amount) }));
}

/** A session receipt as Markdown, for the clipboard. Contains numbers and titles only. */
export function markdownReceipt(detail: SessionDetail): string {
  const { summary } = detail;
  const lines: string[] = [];
  lines.push(`# ${summary.title}`, '');
  lines.push(`- Session: \`${summary.id}\``);
  lines.push(`- Project: ${summary.projectPath}`);
  if (summary.provider === 'codex') lines.push('- Provider: Codex. Amounts are API-price estimates, not your subscription bill. Hook, skill, workflow and agent attribution is unavailable.');
  if (summary.usageIncomplete) lines.push('- Usage incomplete — totals cover recorded tokens only.');
  lines.push(`- Started: ${formatDate(summary.startedAt, 'datetime')}`);
  lines.push(`- Duration: ${formatDuration(summary.durationMs)} (active ${formatDuration(summary.activeMs)})`);
  lines.push(`- Prompts: ${formatCount(summary.promptCount)} · Requests: ${formatCount(summary.requestCount)} · Tool calls: ${formatCount(summary.toolCallCount)}`);
  lines.push('');
  lines.push(summary.provider === 'codex' ? '## Receipt (API-price estimate)' : '## Receipt (exact)', '');
  lines.push('| Item | USD |', '| --- | ---: |');
  for (const row of exactAmounts(summary.cost)) lines.push(`| ${row.label} | ${formatMoney(row.amount)} |`);
  lines.push(`| **Total** | **${formatMoney(summary.cost.total)}** |`);
  lines.push('');
  lines.push('| Where | USD |', '| --- | ---: |');
  for (const row of delegationAmounts(detail)) lines.push(`| ${row.label} | ${formatMoney(row.amount)} |`);
  lines.push('');
  lines.push(summary.provider === 'codex' ? '## By model (API-price estimate)' : '## By model (exact)', '');
  lines.push('| Model | Requests | Input | Output | Cache write | Cache read | USD |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of detail.byModel) {
    lines.push(
      `| ${row.label} | ${formatCount(row.requests)} | ${formatTokensExact(row.tokens.input)} | ${formatTokensExact(row.tokens.output)} | ${formatTokensExact(row.tokens.cache5m + row.tokens.cache1h)} | ${formatTokensExact(row.tokens.cacheRead)} | ${formatMoney(row.cost.total)} |`,
    );
  }
  lines.push('');
  lines.push('## What filled the context (estimated)', '');
  lines.push('| Item | USD (est.) |', '| --- | ---: |');
  for (const row of estimatedAmounts(detail)) lines.push(`| ${row.label} | ${formatMoney(row.amount)} |`);
  const residual = estimatedResidual(detail);
  lines.push(`| ${residual.label} | ${formatMoney(residual.amount)} |`);
  lines.push(`| **Exact session total** | **${formatMoney(summary.cost.total)}** |`);
  const reported = detail.facts.reported;
  if (reported) {
    lines.push('');
    lines.push(`Claude Code’s own tally for this session: ${formatMoney(reported.totalCostUSD)}.`);
  }
  lines.push('');
  lines.push(summary.provider === 'codex' ? '_Amounts price recorded tokens at API list rates; they do not represent a subscription bill._' : `_Request costs are exact; attribution lines are estimated (see Methodology). ${ESTIMATE_DETAIL}_`);
  return lines.join('\n');
}

import { useMemo } from 'react';
import type { CategoryShare, TokenTotals } from '@core/types';
import { plural } from '@core/pricing/format.js';
import { EstimateBadge, Money, Receipt, TokenBar, Tooltip, type ReceiptRow } from '@/components';
import type { CurrencyDisplay } from '@/lib/format';
import { formatPercent, formatTokens } from '@/lib/format';
import { ESTIMATE_DETAIL, RESIDUAL_EXPLANATION } from '@/routes/session/receipt';
import { shortToolLabel } from '@/lib/tools';
import styles from './Overview.module.css';

export interface CategorySplitProps {
  categories: CategoryShare;
  currency: CurrencyDisplay;
  /** how many individual tools to itemise before rolling the rest into one line */
  topTools?: number;
  /**
   * Range token totals. Given, the exact column ends on the four-class token mix — the same
   * split the money above it comes from, in the unit it was billed in.
   */
  tokens?: TokenTotals;
}

/**
 * The same money twice: the exact split by token class, and the estimated split by what
 * filled the context. The estimated side reconciles to the exact total via a residual line —
 * the attribution model does not claim to place every dollar (docs/METHODOLOGY.md §3).
 */
export function CategorySplit({ categories, currency, topTools = 6, tokens }: CategorySplitProps) {
  const { exact, estimated } = categories;

  const exactRows = useMemo<ReceiptRow[]>(() => {
    const money = (usd: number) => <Money usd={usd} currency={currency} />;
    const share = (usd: number) => (exact.total > 0 ? formatPercent(usd / exact.total) : '—');
    return [
      { id: 'output', label: 'Output', value: money(exact.output), note: share(exact.output) },
      { id: 'input', label: 'Input', value: money(exact.input), note: share(exact.input) },
      { id: 'cacheWrite', label: 'Cache write', value: money(exact.cacheWrite), note: share(exact.cacheWrite) },
      { id: 'cacheRead', label: 'Cache read', value: money(exact.cacheRead), note: share(exact.cacheRead) },
      { id: 'webSearch', label: 'Web search', value: money(exact.webSearch), note: share(exact.webSearch) },
      { id: 'total', label: 'Total', value: <Money usd={exact.total} currency={currency} display />, emphasis: 'total' },
    ];
  }, [exact, currency]);

  const estimatedRows = useMemo<ReceiptRow[]>(() => {
    const money = (usd: number) => <Money usd={usd} currency={currency} />;
    const tools = [...estimated.toolResultsByTool].sort((a, b) => b.cost - a.cost);
    const shown = tools.slice(0, topTools);
    const rest = tools.slice(topTools);
    const restCost = rest.reduce((sum, tool) => sum + tool.cost, 0);
    const toolTotal = tools.reduce((sum, tool) => sum + tool.cost, 0);
    const baseline = estimated.baseline ?? 0;
    const assistantHistory = estimated.assistantHistory ?? 0;
    const attributed =
      baseline +
      estimated.assistantOutput +
      estimated.userPrompts +
      toolTotal +
      assistantHistory +
      estimated.hooks +
      estimated.harness +
      estimated.compactSummaries +
      estimated.systemPrompt +
      estimated.other;

    const rows: ReceiptRow[] = [
      {
        id: 'baseline',
        label: 'Baseline context (system prompt, tools, memory)',
        value: (
          <span className={styles.estimatedValue}>
            {money(baseline)} <EstimateBadge method="heuristic" detail={ESTIMATE_DETAIL} />
          </span>
        ),
      },
      { id: 'assistantOutput', label: 'Assistant output', value: money(estimated.assistantOutput) },
      { id: 'userPrompts', label: 'Your prompts', value: money(estimated.userPrompts) },
      { id: 'tools', label: 'Tool results', value: money(toolTotal), emphasis: 'subtotal' },
      ...shown.map<ReceiptRow>((tool) => ({
        id: `tool-${tool.name}`,
        label: shortToolLabel(tool.name),
        value: money(tool.cost),
        note: plural(tool.calls, 'call'),
        indent: 1,
      })),
    ];
    if (rest.length > 0) {
      rows.push({
        id: 'tools-rest',
        label: plural(rest.length, 'other tool'),
        value: money(restCost),
        indent: 1,
        emphasis: 'muted',
      });
    }
    rows.push(
      {
        id: 'assistantHistory',
        label: 'Assistant replies re-sent as history',
        value: (
          <span className={styles.estimatedValue}>
            {money(assistantHistory)} <EstimateBadge method="heuristic" detail={ESTIMATE_DETAIL} />
          </span>
        ),
      },
      { id: 'hooks', label: 'Hook context', value: money(estimated.hooks) },
      { id: 'harness', label: 'Harness injections', value: money(estimated.harness) },
      { id: 'compact', label: 'Compaction summaries', value: money(estimated.compactSummaries) },
      { id: 'systemPrompt', label: 'System prompt', value: money(estimated.systemPrompt) },
      { id: 'other', label: 'Other injections', value: money(estimated.other) },
      { id: 'attributed', label: 'Attributed', value: money(attributed), emphasis: 'subtotal' },
      {
        id: 'residual',
        label: (
          <Tooltip content={RESIDUAL_EXPLANATION} maxWidth={320}>
            <button type="button" className={styles.residualLabel}>
              {exact.total - attributed < 0 ? 'Estimation overshoot' : 'Not attributed'}
            </button>
          </Tooltip>
        ),
        value: money(exact.total - attributed),
        emphasis: 'muted',
      },
      { id: 'total', label: 'Total', value: <Money usd={exact.total} currency={currency} display />, emphasis: 'total' },
    );
    return rows;
  }, [estimated, exact.total, currency, topTools]);

  return (
    <div className={styles.split}>
      <div className={`${styles.receiptPanel} ${styles.exactPanel}`}>
        <div className="stack stack-sm">
          <div className={styles.receiptHead}>
            <h3>API list prices — by token class</h3>
            <span className="ui-xs muted-2">from the API usage numbers</span>
          </div>
          <Receipt rows={exactRows} />
        </div>
        <div className={styles.tokenMix}>
          <span className="eyebrow">Reading the estimated split</span>
          <p className="ui-xs muted">
            An allocation of the same money, not a second measurement. {ESTIMATE_DETAIL} What is left over is
            context the transcript never recorded, shown as its own line rather than folded into a category.
          </p>
        </div>
        {tokens ? (
          <div className={styles.tokenMix}>
            <span className="eyebrow">Token mix</span>
            <TokenBar
              tokens={tokens}
              height={12}
              ariaLabel={`Token mix for the range: ${formatTokens(tokens.output)} output, ${formatTokens(
                tokens.input,
              )} input, ${formatTokens(tokens.cache5m + tokens.cache1h)} cache write, ${formatTokens(
                tokens.cacheRead,
              )} cache read.`}
            />
          </div>
        ) : null}
      </div>
      <div className={styles.receiptPanel}>
        <div className={styles.receiptHead}>
          <h3>
            Estimated — by what filled the context <EstimateBadge method="delta" detail={ESTIMATE_DETAIL} />
          </h3>
        </div>
        <Receipt rows={estimatedRows} />
      </div>
    </div>
  );
}

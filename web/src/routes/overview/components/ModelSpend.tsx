import { useMemo } from 'react';
import type { ModelCostRow } from '@core/types';
import { plural } from '@core/pricing/format.js';
import { ChartFrame, LedgerTable, ModelChip, Money, Tokens, TokenBar, Tooltip, type LedgerColumn } from '@/components';
import { BarLegend } from '@/lib/bars';
import { TOKEN_CLASS_COLOR, TOKEN_CLASS_LABEL, TOKEN_CLASS_ORDER, TOKEN_CLASS_PATTERN } from '@/lib/chart';
import type { CurrencyDisplay } from '@/lib/format';
import { formatCount, formatPercent, formatTokens } from '@/lib/format';
import styles from './Overview.module.css';

/** The four bar classes read off a `TokenTotals` (cache write is the 5m + 1h sum). */
function tokenClassValue(tokens: ModelCostRow['tokens'], key: (typeof TOKEN_CLASS_ORDER)[number]): number {
  switch (key) {
    case 'output':
      return tokens.output;
    case 'input':
      return tokens.input;
    case 'cacheWrite':
      return tokens.cache5m + tokens.cache1h;
    case 'cacheRead':
      return tokens.cacheRead;
  }
}

const TOKEN_LEGEND = TOKEN_CLASS_ORDER.map((key) => ({
  id: key,
  label: TOKEN_CLASS_LABEL[key],
  color: TOKEN_CLASS_COLOR[key],
  pattern: TOKEN_CLASS_PATTERN[key],
}));

/**
 * Why a model can bill money on no requests of its own: the request that paid was recorded
 * against another model, and this row is the fallback iteration the API charged for inside it.
 * Printing a bare `0` next to a real dollar figure reads as a bug in the ledger, so the count
 * becomes an em dash carrying this sentence.
 */
const FALLBACK_EXPLANATION =
  'Billed as a fallback iteration of another model\u2019s request, so the spend has no request of its own in this range.';

/** True when a row has money but no request to hang it on. */
function isFallbackOnly(row: ModelCostRow): boolean {
  return row.requests === 0 && row.cost.total > 0;
}

export interface ModelSpendProps {
  models: ModelCostRow[];
  total: number;
  currency: CurrencyDisplay;
  /**
   * When given, the chart renders its own `<h2 id>` inside the frame's caption, so the heading,
   * the legend and the chart/table toggle share one row. Without it the caller supplies the
   * heading and the frame's header holds only the legend and the toggle.
   */
  headingId?: string;
}

/** Spend per model, with each model's token mix on its own 4-class bar (SPEC §8.4). */
export function ModelSpend({ models, total, currency, headingId }: ModelSpendProps) {
  const rows = useMemo(() => [...models].sort((a, b) => b.cost.total - a.cost.total), [models]);

  const columns = useMemo<LedgerColumn<ModelCostRow>[]>(
    () => [
      {
        id: 'model',
        header: 'Model',
        width: '30%',
        sortValue: (row) => row.label,
        cell: (row) => <ModelChip model={row.model} label={row.label} family={row.family} />,
      },
      {
        id: 'requests',
        header: 'Requests',
        numeric: true,
        sortValue: (row) => row.requests,
        cell: (row) =>
          isFallbackOnly(row) ? (
            <abbr className={styles.fallbackCount} title={FALLBACK_EXPLANATION}>
              —
            </abbr>
          ) : (
            formatCount(row.requests)
          ),
      },
      {
        id: 'output',
        header: 'Output tok',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.tokens.output,
        cell: (row) => <Tokens value={row.tokens.output} />,
      },
      {
        id: 'context',
        header: 'Context tok',
        numeric: true,
        secondary: true,
        sortValue: (row) => row.tokens.context,
        cell: (row) => <Tokens value={row.tokens.context} />,
      },
      {
        id: 'cost',
        header: 'Cost',
        numeric: true,
        sortValue: (row) => row.cost.total,
        cell: (row) => <Money usd={row.cost.total} currency={currency} />,
      },
      {
        id: 'share',
        header: 'Share',
        numeric: true,
        sortValue: (row) => row.cost.total,
        cell: (row) => formatPercent(total > 0 ? row.cost.total / total : 0),
      },
    ],
    [currency, total],
  );

  const summary = rows.length
    ? `Spend by model; each bar's length is that model's share of spend, split by token class. ${rows
        .slice(0, 3)
        .map((row) => `${row.label} ${formatPercent(total > 0 ? row.cost.total / total : 0)}`)
        .join(', ')} of ${plural(rows.length, 'model')} in range.`
    : 'No model spend in this range.';

  return (
    <ChartFrame
      summary={summary}
      {...(headingId
        ? { heading: { id: headingId, text: 'Spend by model', note: 'recorded usage at API list prices' } }
        : {})}
      legend={<BarLegend segments={TOKEN_LEGEND} />}
      table={<LedgerTable columns={columns} rows={rows} rowKey={(row) => row.model} caption="Spend by model" dense />}
    >
      <ul className={styles.list}>
        {rows.map((row) => {
          // Bar length is the model's share of spend, so the six rows compare at a glance;
          // the four token classes still split the inside of each bar.
          const share = total > 0 ? row.cost.total / total : 0;
          return (
            <li key={row.model} className={styles.modelRow}>
              <div className={styles.modelHead}>
                <ModelChip model={row.model} label={row.label} family={row.family} />
                <span className={`${styles.modelName} truncate muted`}>
                  {isFallbackOnly(row) ? (
                    <Tooltip content={FALLBACK_EXPLANATION} maxWidth={320}>
                      <button type="button" className={styles.fallbackNote}>
                        — requests
                      </button>
                    </Tooltip>
                  ) : (
                    plural(row.requests, 'request')
                  )}
                  {row.unpriced ? ' · unpriced' : ''}
                </span>
                <span className={styles.modelMeta}>{formatPercent(share)}</span>
                <Money usd={row.cost.total} currency={currency} />
              </div>
              <TokenBar
                tokens={row.tokens}
                showLegend={false}
                height={8}
                fraction={share}
                ariaLabel={`${row.label}: ${formatPercent(share)} of spend in range. Token mix: ${TOKEN_CLASS_ORDER.map(
                  (key) => `${TOKEN_CLASS_LABEL[key]} ${formatTokens(tokenClassValue(row.tokens, key))}`,
                ).join(', ')}.`}
              />
            </li>
          );
        })}
      </ul>
    </ChartFrame>
  );
}

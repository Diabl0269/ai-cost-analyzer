import type { EstMethod } from '@core/types';
import { Tooltip } from '@/components/Tooltip';
import { formatMoney } from '@/lib/format';
import styles from './EstimateBadge.module.css';

export interface EstimateBadgeProps {
  /** how the underlying number was derived (SPEC §5.3) */
  method?: EstMethod;
  /** extra sentence appended to the explanation */
  detail?: string;
  size?: 'sm' | 'md';
  /** `estimateAs` estimate: shows "≈ $X if billed as …" for a model that still has no price */
  billedAs?: { label: string; usd: number };
}

const EXPLANATION: Record<EstMethod, string> = {
  delta: 'Estimated. Token counts were scaled to the measured context growth between the two requests around this item, so it is the most reliable estimate class.',
  heuristic: 'Estimated. Token counts come from characters ÷ the model’s characters-per-token, because the context delta was unusable (a compaction, or an implausible ratio).',
  image: 'Estimated. Images are counted at a flat 1,600 tokens each.',
  none: 'Estimated. The source text was not recorded, so this is a floor, not a measurement.',
};

/**
 * The "est." marker required next to every attributed number (SPEC §5.3).
 * Exact figures — request cost, category split — never carry it.
 */
export function EstimateBadge({ method = 'heuristic', detail, size = 'sm', billedAs }: EstimateBadgeProps) {
  if (billedAs) {
    return (
      <Tooltip
        content={`Estimate only. This model has no published price, so recorded cost excludes it. This is what its tokens would cost at ${billedAs.label} list prices.`}
        maxWidth={300}
      >
        <abbr className={[styles.badge, size === 'md' ? styles.md : null].filter(Boolean).join(' ')} title="">
          ≈ {formatMoney(billedAs.usd)} if billed as {billedAs.label}
        </abbr>
      </Tooltip>
    );
  }
  const text = `${EXPLANATION[method]}${detail ? ` ${detail}` : ''} Requests themselves are exact: they come from the API usage numbers in the transcript.`;
  return (
    <Tooltip content={text} maxWidth={300}>
      <abbr className={[styles.badge, size === 'md' ? styles.md : null].filter(Boolean).join(' ')} title="">
        est.
      </abbr>
    </Tooltip>
  );
}

import { Link } from '@/lib/navigation';
import type { Insight } from '@core/types';
import { Money } from '@/components';
import type { CurrencyDisplay } from '@/lib/format';
import { truncate } from '@/lib/format';
import styles from './InsightCard.module.css';

const KIND_LABEL: Record<Insight['kind'], string> = {
  saving: 'Saving',
  waste: 'Waste',
  info: 'Info',
};

const IMPACT_LABEL: Record<Insight['kind'], string> = {
  saving: 'could be saved',
  waste: 'spent',
  info: 'in range',
};

export interface InsightCardProps {
  insight: Insight;
  currency: CurrencyDisplay;
  /** the compact form used in the overview's "top three" strip */
  compact?: boolean;
  /** how many affected sessions to link (the rest are summarised) */
  maxSessions?: number;
}

/**
 * One finding from the insights engine (SPEC §10.3). The impact is money the engine already
 * computed from exact request costs and estimated attribution, so it is presented as a figure,
 * not a badge — the explanation says which part is an estimate.
 */
export function InsightCard({ insight, currency, compact = false, maxSessions = 3 }: InsightCardProps) {
  const shown = insight.sessions.slice(0, maxSessions);
  const remaining = insight.sessions.length - shown.length;

  return (
    <article
      id={compact ? undefined : `insight-${insight.id}`}
      className={[styles.card, styles[insight.kind], compact ? styles.compact : null].filter(Boolean).join(' ')}
      aria-labelledby={`${insight.id}-title${compact ? '-compact' : ''}`}
    >
      <h3 id={`${insight.id}-title${compact ? '-compact' : ''}`} className={styles.heading}>
        {insight.title}
      </h3>
      <p className={styles.impact}>
        <Money
          usd={insight.impactUsd}
          currency={currency}
          display
          tone={insight.kind === 'saving' ? 'save' : insight.kind === 'waste' ? 'cost' : 'none'}
          className={styles.impactValue}
        />
        <span className={styles.impactLabel}>{IMPACT_LABEL[insight.kind]}</span>
      </p>
      <p className={styles.body}>{insight.explanation}</p>
      <div className={styles.meta}>
        <span className={styles.tag}>
          <span className={styles.dot} aria-hidden="true" />
          {KIND_LABEL[insight.kind]}
        </span>
        {insight.metric ? (
          <span className={styles.metric}>
            {insight.metric.label}
            <span className="num">{insight.metric.value}</span>
          </span>
        ) : null}
        {/* Four session titles clipped to a third of a word each said nothing. The label counts
            them, and past two chips the list takes a line of its own and wraps. */}
        {shown.length > 0 ? (
          <span className={styles.sessions} data-many={shown.length > 2 ? 'true' : undefined}>
            <span className="muted-2 ui-xs">
              {insight.sessions.length === 1 ? '1 session' : `${insight.sessions.length} sessions`}
            </span>
            {shown.map((session) => (
              <Link key={session.sessionId} to={`/sessions/${session.sessionId}`} className={styles.sessionLink}>
                {truncate(session.title, 40)}
              </Link>
            ))}
            {remaining > 0 ? <span className="muted-2 ui-xs">+{remaining} more</span> : null}
          </span>
        ) : null}
      </div>
    </article>
  );
}

import { hasNoRecordedUsage } from '@/lib/usage';
import { useMemo, useState } from 'react';
import { Link } from '@/lib/navigation';
import { plural } from '@core/pricing/format.js';
import type { ModelCostRow, RequestCost } from '@core/types';
import { EmptyState } from '@/components/EmptyState';
import { Callout } from '@/components/Callout';
import { ContextStrip, type ContextSegment } from '@/components/ContextStrip';
import { CostWaterfall, type WaterfallDatum } from '@/components/CostWaterfall';
import { EstimateBadge } from '@/components/EstimateBadge';
import { Icon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { LedgerTable, type LedgerColumn } from '@/components/LedgerTable';
import { ModelChip } from '@/components/ModelChip';
import { Money } from '@/components/Money';
import { Receipt } from '@/components/Receipt';
import { Tokens } from '@/components/Tokens';
import { Tooltip } from '@/components/Tooltip';
import { useToast } from '@/components/Toast';
import { Duration } from '@/components/Duration';
import { TOKEN_CLASS_COLOR, TOKEN_CLASS_PATTERN } from '@/lib/chart';
import { formatCount, formatDate, formatMoney, formatPercent, formatTokensExact, truncateMiddle } from '@/lib/format';
import { REPORTED_STATUS } from '@/routes/sessions/ReportedBadge';
import { useSessionContext } from '../context';
import {
  ESTIMATED_CONTEXT_IDS,
  ESTIMATE_DETAIL,
  RESIDUAL_EXPLANATION,
  costDriver,
  delegationAmounts,
  estimatedAmounts,
  estimatedResidual,
  exactAmounts,
  toReceiptRows,
} from '../receipt';
import styles from './Summary.module.css';

function contextSegments(request: RequestCost): ContextSegment[] {
  const write = request.usage.cache5m + request.usage.cache1h;
  return [
    {
      id: 'input',
      label: 'Fresh input',
      tokens: request.usage.input,
      cost: request.cost.input,
      color: TOKEN_CLASS_COLOR.input,
      pattern: TOKEN_CLASS_PATTERN.input,
    },
    {
      id: 'cacheWrite',
      label: 'Cache write',
      tokens: write,
      cost: request.cost.cacheWrite,
      color: TOKEN_CLASS_COLOR.cacheWrite,
      pattern: TOKEN_CLASS_PATTERN.cacheWrite,
    },
    {
      id: 'cacheRead',
      label: 'Cache read',
      tokens: request.usage.cacheRead,
      cost: request.cost.cacheRead,
      color: TOKEN_CLASS_COLOR.cacheRead,
      pattern: TOKEN_CLASS_PATTERN.cacheRead,
    },
  ].filter((segment) => segment.tokens > 0);
}

export default function SummaryTab() {
  const { id, detail } = useSessionContext();
  const { summary } = detail;
  const { toast } = useToast();
  const driver = useMemo(() => costDriver(detail), [detail]);

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(detail.filePath);
      toast({ title: 'Transcript path copied', tone: 'save' });
    } catch {
      toast({ title: 'Could not reach the clipboard', description: 'Your browser blocked the copy.', tone: 'warn' });
    }
  };
  const priciest = useMemo(
    () => detail.requests.reduce<RequestCost | null>((best, request) => (best && best.cost.total >= request.cost.total ? best : request), null),
    [detail.requests],
  );
  const [selectedSeq, setSelectedSeq] = useState<number | null>(priciest?.seq ?? null);
  const selected = detail.requests.find((request) => request.seq === selectedSeq) ?? priciest ?? null;

  const waterfall = useMemo<WaterfallDatum[]>(
    () =>
      detail.requests.map((request) => ({
        seq: request.seq,
        ...(request.ts ? { ts: request.ts } : {}),
        model: request.model,
        total: request.cost.total,
        segments: {
          output: request.cost.output,
          input: request.cost.input,
          cacheWrite: request.cost.cacheWrite,
          cacheRead: request.cost.cacheRead,
        },
      })),
    [detail.requests],
  );

  const modelColumns: LedgerColumn<ModelCostRow>[] = [
    { id: 'model', header: 'Model', width: '30%', cell: (row) => <ModelChip model={row.model} label={row.label} size="md" /> },
    { id: 'requests', header: 'Requests', numeric: true, cell: (row) => formatCount(row.requests) },
    { id: 'input', header: 'Input', numeric: true, cell: (row) => <Tokens value={row.tokens.input} /> },
    { id: 'output', header: 'Output', numeric: true, cell: (row) => <Tokens value={row.tokens.output} /> },
    { id: 'write', header: 'Cache write', numeric: true, cell: (row) => <Tokens value={row.tokens.cache5m + row.tokens.cache1h} /> },
    { id: 'read', header: 'Cache read', numeric: true, cell: (row) => <Tokens value={row.tokens.cacheRead} /> },
    { id: 'cost', header: 'Cost', numeric: true, cell: (row) => <Money usd={row.cost.total} className={styles.strong} /> },
  ];

  /**
   * The estimated split, its residual and the exact total it reconciles to. Both the rows and the
   * Markdown copy come from `../receipt`, so the clipboard can never drift from the screen.
   */
  const contextRows = useMemo(() => {
    const residual = estimatedResidual(detail);
    const rows = toReceiptRows(estimatedAmounts(detail), (amount) => <Money usd={amount} />).map((row) =>
      ESTIMATED_CONTEXT_IDS.has(row.id)
        ? {
            ...row,
            value: (
              <span className={styles.estimated}>
                {row.value} <EstimateBadge method="heuristic" detail={ESTIMATE_DETAIL} />
              </span>
            ),
          }
        : row,
    );
    rows.push({
      id: residual.id,
      label: (
        <Tooltip content={RESIDUAL_EXPLANATION} maxWidth={320}>
          <button type="button" className={styles.residualLabel}>
            {residual.label}
          </button>
        </Tooltip>
      ),
      value: <Money usd={residual.amount} />,
      emphasis: 'muted',
    });
    rows.push({
      id: 'exact',
      label: summary.provider === 'codex' ? 'Session total (API-price estimate)' : 'Exact session total',
      value: <Money usd={summary.cost.total} />,
      emphasis: 'total',
    });
    return rows;
  }, [detail, summary.cost.total]);

  const reported = detail.facts.reported;
  const comparison = detail.facts.reportedComparison;

  if (hasNoRecordedUsage(summary)) {
    return <EmptyState title="Token usage unavailable" description="This transcript has no recorded token usage, so its cost and cost breakdown are unavailable. You can still read its transcript and recorded tool calls." />;
  }

  return (
    <div className="stack stack-lg">
      <section className={styles.receipts}>
        <div className="panel panel-pad">
          <Receipt
            caption={summary.provider === 'codex' ? 'Receipt — API-price estimate' : 'Receipt — exact'}
            rows={[
              ...toReceiptRows(exactAmounts(summary.cost), (amount) => <Money usd={amount} />),
              { id: 'total', label: 'Session total', value: <Money usd={summary.cost.total} display />, emphasis: 'total' },
            ]}
            footer={
              <span className={styles.footNote}>
                {summary.provider === 'codex' ? 'Recorded token counts priced at API list rates. This is not your subscription bill.' : 'Every line comes from the API usage numbers in the transcript — no estimation.'}
              </span>
            }
          />
          {/* One category over half the bill is the whole story of the session; anything more
              evenly split has no headline and gets none. */}
          {driver ? <p className={styles.driver}>{driver}</p> : null}
        </div>

        <div className="panel panel-pad">
          <Receipt
            caption="Where the work happened"
            rows={[
              ...toReceiptRows(delegationAmounts(detail), (amount) => <Money usd={amount} />),
              { id: 'total', label: 'Session total', value: <Money usd={summary.cost.total} />, emphasis: 'total' },
            ]}
          />
          {summary.provider === 'codex' ? <p className={styles.tallyNote}>Codex does not report a Claude Code cost-state tally. API list-price estimates cannot be reconciled with a subscription bill.</p> : reported ? (
            <div className={styles.tally}>
              <Receipt
                dense
                caption="Claude Code’s own tally"
                rows={[
                  { id: 'reported', label: 'It reported', value: <Money usd={reported.totalCostUSD} /> },
                  { id: 'ours', label: 'We counted', value: <Money usd={summary.cost.total} /> },
                  {
                    id: 'delta',
                    label: 'Difference',
                    value: <Money usd={summary.cost.total - reported.totalCostUSD} delta tone="auto" />,
                    ...(comparison ? { note: `${formatPercent(comparison.deltaPct / 100)} of the larger figure` } : {}),
                  },
                ]}
              />
              <p className={styles.tallyNote}>{summary.reportedStatus ? REPORTED_STATUS[summary.reportedStatus].meaning : ''}</p>
            </div>
          ) : (
            <p className={styles.tallyNote}>
              This session has no <code>cost-state</code> line, so Claude Code never reported a total to
              compare against.
            </p>
          )}
        </div>
      </section>

      <section className="stack stack-sm">
        <div className="section-head">
          <h2>By model</h2>
          <span className={styles.note}>Per recorded request, at API list prices</span>
        </div>
        <LedgerTable
          columns={modelColumns}
          rows={detail.byModel}
          rowKey={(row) => row.model}
          caption="Cost by model"
          dense
          empty="No billed request in this session."
        />
        {summary.unpriced ? (
          <Callout tone="warn" title="Unpriced model">
            One of the models here has no entry in the pricing table, so the total is a floor. Add a price
            in Settings to complete it.
          </Callout>
        ) : null}
      </section>

      {/* Exploratory, not part of the receipt: on paper it costs a page and cannot be clicked. */}
      <section className="stack stack-sm" data-print-hide>
        <div className="section-head">
          <h2>Every request</h2>
          <span className={styles.note}>
            {plural(detail.requests.length, 'request')} · click a bar for its details
          </span>
        </div>
        <CostWaterfall
          data={waterfall}
          selectedSeq={selected?.seq ?? null}
          onSelect={(datum) => setSelectedSeq(datum.seq)}
          title="Cost per request, in order"
        />
        {selected ? (
          <div className={styles.request}>
            <div className={styles.requestHead}>
              <ModelChip model={selected.model} size="md" />
              <span className={['num', styles.requestSeq].join(' ')}>#{selected.seq}</span>
              <span className={styles.note}>turn {selected.turnIndex}</span>
              <span className={styles.note}>{formatDate(selected.ts, 'datetime')}</span>
              <Money usd={selected.cost.total} className={styles.strong} />
              <Link className={styles.jump} to={`/sessions/${encodeURIComponent(id)}/transcript?seq=${selected.seq}`}>
                <Icon name="external" size={12} /> open in transcript
              </Link>
            </div>
            <ContextStrip
              segments={contextSegments(selected)}
              total={selected.contextTokens}
              ariaLabel={`What filled the context at request ${selected.seq}`}
            />
            <dl className={styles.requestFacts}>
              <div>
                <dt>Context</dt>
                <dd>
                  <Tokens value={selected.contextTokens} unit="tok" />
                </dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>
                  <Tokens value={selected.usage.output} unit="tok" />
                  {selected.usage.thinking > 0 ? (
                    <span className={styles.note}> ({formatTokensExact(selected.usage.thinking)} thinking)</span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>Cache hit</dt>
                <dd>{formatPercent(selected.cacheHitRatio)}</dd>
              </div>
              <div>
                <dt>Stop reason</dt>
                <dd>{selected.stopReason ?? '—'}</dd>
              </div>
              <div>
                <dt>Tools emitted</dt>
                <dd>{selected.toolNames.length > 0 ? selected.toolNames.join(', ') : '—'}</dd>
              </div>
            </dl>
            <div className={styles.flags}>
              {selected.coldCache ? (
                <span className={styles.flag} data-tone="warn">
                  cold cache — {formatTokensExact(selected.contextTokens)} tokens were re-sent with no cache to read
                </span>
              ) : null}
              {selected.isFallback ? (
                <span className={styles.flag} data-tone="warn">
                  fallback — the requested model was unavailable and every iteration was billed
                </span>
              ) : null}
              {selected.speed === 'fast' ? <span className={styles.flag}>fast mode pricing</span> : null}
              {selected.unpriced ? <span className={styles.flag} data-tone="warn">no price for this model</span> : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className={styles.split}>
        <div className="stack stack-sm">
          <div className="section-head">
            <h2>
              What filled the context <EstimateBadge method="delta" detail={ESTIMATE_DETAIL} />
            </h2>
          </div>
          <div className="panel panel-pad">
            <Receipt
              rows={contextRows}
              footer={
                <span className={styles.footNote}>
                  Attribution splits each request’s cost across the things that filled its context, so
                  these lines are estimates that reconcile to — rather than exactly equal — the total
                  above. {ESTIMATE_DETAIL}
                </span>
              }
            />
          </div>
        </div>

        <div className="stack stack-sm">
          <div className="section-head">
            <h2>Compactions and errors</h2>
          </div>
          <div className="panel panel-pad stack stack-sm">
            {detail.compactions.length === 0 ? (
              <p className={styles.note}>No compaction recorded in this transcript.</p>
            ) : (
              detail.compactions.map((compaction) => (
                <div key={`${compaction.agentId ?? 'main'}-${compaction.seq}`} className={styles.compaction}>
                  <span className={styles.compactionHead}>
                    <Icon name="warning" size={13} /> {compaction.trigger ?? 'compaction'} at turn {compaction.turnIndex}
                  </span>
                  <span className={styles.note}>
                    dropped {formatTokensExact((compaction.preTokens ?? 0) - (compaction.postTokens ?? 0))} tokens
                    {compaction.durationMs ? (
                      <>
                        {' '}
                        · took <Duration ms={compaction.durationMs} />
                      </>
                    ) : null}
                  </span>
                  <span className={styles.note}>
                    re-warming the cache afterwards cost <Money usd={compaction.rewarmCost} />
                  </span>
                </div>
              ))
            )}
            {detail.apiErrors.length > 0 ? (
              <p className={styles.note}>
                {plural(detail.apiErrors.length, 'API error')} —{' '}
                {[...new Set(detail.apiErrors.map((error) => error.status ?? 0))].join(', ')} (retries are not
                billed twice; only completed responses carry usage).
              </p>
            ) : null}
            {detail.facts.localCommands.length > 0 ? (
              <p className={styles.note}>
                Slash commands used: {[...new Set(detail.facts.localCommands)].join(', ')}
              </p>
            ) : null}
            {/* An unlabelled absolute path clipped in the middle of its own filename read like
                a bug. The label says what it is, the truncation keeps the file name, and the
                whole thing is one click away from the clipboard. */}
            <div className={styles.file}>
              <span className="eyebrow">Transcript file</span>
              <span className={styles.path} title={detail.filePath}>
                {truncateMiddle(detail.filePath, 46)}
              </span>
              <IconButton icon="copy" size="sm" label="Copy the transcript file path" onClick={() => void copyPath()} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

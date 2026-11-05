import { hasNoRecordedUsage } from '@/lib/usage';
import { useMemo, useRef, useState } from 'react';
import { scaleLinear } from 'd3-scale';
import { plural } from '@core/pricing/format.js';
import type { TurnSummary } from '@core/types';
import { ChartFrame } from '@/components/ChartFrame';
import { Duration } from '@/components/Duration';
import { EmptyState } from '@/components/EmptyState';
import { LedgerTable, type LedgerColumn } from '@/components/LedgerTable';
import { Money } from '@/components/Money';
import { Tokens } from '@/components/Tokens';
import { useElementWidth } from '@/lib/chart';
import { formatCount, formatDate, formatDuration, formatMoney } from '@/lib/format';
import { cleanPromptText } from '../transcript/prompt';
import { idleGaps, type IdleGap } from '../gaps';
import { SHORT_SPAN_MS, axisFractions, elapsedTick } from '../timeline-axis';
import { useSessionContext } from '../context';
import styles from './Timeline.module.css';

const MARGIN = { top: 12, right: 10, bottom: 34, left: 52 };
const INNER_HEIGHT = 174;
/** Narrower than this and two adjacent turns read as one block. */
const MIN_BAR_PX = 3;


export default function TimelineTab() {
  const { detail } = useSessionContext();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrapRef);
  const [focused, setFocused] = useState(0);
  // Which turn is showing its label. Set by hover and by focus, cleared by Escape (WCAG 2.2
  // 1.4.13 asks for a hover label a reader can dismiss without moving the pointer).
  const [labelled, setLabelled] = useState<number | null>(null);

  const turns = detail.turns;
  const gaps = useMemo(() => idleGaps(detail.requests), [detail.requests]);

  const bounds = useMemo(() => {
    const stamps: number[] = [];
    for (const turn of turns) stamps.push(new Date(turn.ts).getTime());
    for (const request of detail.requests) stamps.push(new Date(request.ts).getTime());
    // The clock ends when the session did, not when the longest turn's recorded duration would
    // run out: a turn whose duration overlaps the next one used to stretch the axis past the
    // window the header prints. Bars are clamped to the plot instead.
    const { endedAt } = detail.summary;
    if (endedAt) stamps.push(new Date(endedAt).getTime());
    const finite = stamps.filter((value) => Number.isFinite(value));
    const start = finite.length > 0 ? Math.min(...finite) : 0;
    const lastTurn = turns[turns.length - 1];
    const end = Math.max(
      finite.length > 0 ? Math.max(...finite) : 1,
      lastTurn ? new Date(lastTurn.ts).getTime() + (lastTurn.durationMs ?? 0) : 0,
    );
    return { start, end: end > start ? end : start + 1 };
  }, [turns, detail.requests, detail.summary]);

  const spanMs = bounds.end - bounds.start;
  // Under an hour the axis counts elapsed seconds and needs a second line to say what it counts
  // from; over an hour the two absolute timestamps differ on their own.
  const shortSpan = spanMs < SHORT_SPAN_MS;
  const marginBottom = shortSpan ? MARGIN.bottom + 13 : MARGIN.bottom;
  const chartHeight = MARGIN.top + INNER_HEIGHT + marginBottom;
  const innerWidth = Math.max(80, width - MARGIN.left - MARGIN.right);
  const innerHeight = INNER_HEIGHT;
  const barArea = innerHeight - 26;
  const x = scaleLinear().domain([bounds.start, bounds.end]).range([0, innerWidth]);
  const peakCost = turns.reduce((max, turn) => Math.max(max, turn.cost), 0);
  const y = scaleLinear().domain([0, peakCost || 1]).range([barArea, 0]).nice(3);

  const totalIdle = gaps.reduce((sum, gap) => sum + gap.ms, 0);
  const totalRewarm = gaps.reduce((sum, gap) => sum + gap.rewarmCost, 0);

  const axisTicks = axisFractions(shortSpan).map((fraction) => ({
    fraction,
    label: shortSpan
      ? elapsedTick(fraction * spanMs, spanMs)
      : formatDate(bounds.start + fraction * spanMs, 'datetime'),
  }));

  const labelledTurn = (() => {
    const turn = labelled === null ? undefined : turns[labelled];
    if (!turn) return null;
    const startMs = new Date(turn.ts).getTime();
    if (!Number.isFinite(startMs)) return null;
    const text = `Turn ${turn.turnIndex} · ${formatDuration(turn.durationMs ?? 0)} · ${formatMoney(turn.cost)}`;
    // Geist Mono at 10px is a hair over 6px per character; the box is measured from that rather
    // than from the DOM so the label lands in one paint.
    const width = text.length * 6.1 + 14;
    const centre = x(startMs) + Math.max(MIN_BAR_PX, x(startMs + (turn.durationMs ?? 0)) - x(startMs)) / 2;
    return {
      text,
      width,
      left: Math.max(0, Math.min(centre - width / 2, innerWidth - width)),
      top: Math.max(0, y(turn.cost) - 23),
    };
  })();

  const summary =
    `Session timeline: ${plural(turns.length, 'turn')} between ${formatDate(bounds.start, 'datetime')} and ` +
    `${formatDate(bounds.end, 'datetime')}. A bar spans a turn's stretch of the clock and its height is what the turn cost. ` +
    (gaps.length === 0
      ? 'No idle gap over five minutes, so the cache stayed warm from start to finish.'
      : `${plural(gaps.length, 'idle gap')} over five minutes total ${formatDuration(totalIdle)}, and the first ` +
        `request after ${gaps.length === 1 ? 'it' : 'them'} paid ${formatMoney(totalRewarm)} to re-warm the cache.`);

  const turnColumns: LedgerColumn<TurnSummary>[] = [
    { id: 'turn', header: 'Turn', numeric: true, width: '64px', cell: (turn) => turn.turnIndex },
    { id: 'ts', header: 'At', width: '150px', cell: (turn) => formatDate(turn.ts, 'datetime') },
    {
      id: 'prompt',
      header: 'Prompt',
      // Cleaned for the same reason the transcript's turn headers are: a turn opened by a slash
      // command arrives as `<command-name>/model</command-name>…`, which is not English.
      cell: (turn) => {
        const preview = cleanPromptText(turn.promptPreview);
        return (
          <span className="truncate" title={preview}>
            {preview || '—'}
          </span>
        );
      },
    },
    { id: 'requests', header: 'Requests', numeric: true, width: '84px', cell: (turn) => formatCount(turn.requestCount) },
    { id: 'tools', header: 'Tools', numeric: true, width: '72px', cell: (turn) => formatCount(turn.toolCallCount) },
    { id: 'duration', header: 'Took', numeric: true, width: '92px', cell: (turn) => <Duration ms={turn.durationMs ?? null} /> },
    { id: 'cost', header: 'Cost', numeric: true, width: '96px', cell: (turn) => <Money usd={turn.cost} /> },
  ];

  const gapColumns: LedgerColumn<IdleGap>[] = [
    { id: 'from', header: 'From', width: '150px', cell: (gap) => formatDate(gap.fromMs, 'datetime') },
    { id: 'len', header: 'Idle', numeric: true, width: '100px', sortValue: (gap) => gap.ms, cell: (gap) => <Duration ms={gap.ms} /> },
    {
      id: 'effect',
      header: 'Cache',
      width: '190px',
      cell: (gap) => (
        <span className={styles.effect} data-long={gap.expired === '1h' ? 'true' : undefined}>
          {gap.expired === '1h' ? '5-minute and 1-hour expired' : '5-minute expired'}
        </span>
      ),
    },
    { id: 'tokens', header: 'Re-written', numeric: true, width: '104px', cell: (gap) => <Tokens value={gap.rewarmTokens} /> },
    {
      id: 'cost',
      header: 'Re-warm',
      numeric: true,
      width: '100px',
      sortValue: (gap) => gap.rewarmCost,
      cell: (gap) => <Money usd={gap.rewarmCost} />,
    },
  ];

  if (hasNoRecordedUsage(detail.summary)) {
    return <EmptyState title="Cost timeline unavailable" description="No token usage was recorded for this transcript. Its prompts and tool calls are still available in the Transcript tab." />;
  }

  if (turns.length === 0) {
    return <EmptyState icon="chart" title="No turn to plot" description="This session has no human prompt, so there is no timeline to draw." />;
  }

  const focusBar = (index: number): void => {
    const clamped = Math.max(0, Math.min(index, turns.length - 1));
    setFocused(clamped);
    wrapRef.current?.querySelector<HTMLElement>(`[data-turn-index="${clamped}"]`)?.focus();
  };

  return (
    <div className="stack stack-lg">
      <section aria-labelledby="timeline-chart-heading" className="stack">
        <ChartFrame
          summary={summary}
          heading={{ id: 'timeline-chart-heading', text: 'Turns, idle gaps and errors along the clock' }}
          table={
            <LedgerTable columns={turnColumns} rows={turns} rowKey={(turn) => String(turn.turnIndex)} caption="Turns" dense maxHeight={420} />
          }
          legend={
            <>
              <span className={styles.legendItem}>
                <span className={styles.swatchBar} /> turn (width = its stretch of the clock, height = cost)
              </span>
              <span className={styles.legendItem}>
                <span className={styles.swatchIdle} /> idle over 5 min
              </span>
              <span className={styles.legendItem}>
                <span className={styles.swatchError} /> API error
              </span>
              <span className={styles.legendItem}>
                <span className={styles.swatchCompaction} /> compaction
              </span>
            </>
          }
        >
          <div ref={wrapRef} className={styles.wrap}>
            <svg width={width} height={chartHeight} className={styles.svg} role="img" aria-label={summary}>
              <title>Session timeline</title>
              <desc>{summary}</desc>
              <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
                {y.ticks(3).map((tick) => (
                  <g key={tick} transform={`translate(0,${y(tick)})`}>
                    <line x1="0" x2={innerWidth} className={styles.grid} />
                    <text x="-8" dy="0.32em" textAnchor="end" className={['num', styles.axis].join(' ')}>
                      {formatMoney(tick)}
                    </text>
                  </g>
                ))}

                {/* Idle time is a ribbon under the baseline, not a wash across the plot: on a
                    multi-day session the gaps are most of the width and would drown the bars. */}
                {gaps.map((gap) => (
                  <rect
                    key={gap.id}
                    x={x(gap.fromMs)}
                    y={barArea + 2}
                    width={Math.max(1, x(gap.toMs) - x(gap.fromMs))}
                    height={5}
                    className={gap.expired === '1h' ? styles.idleLong : styles.idle}
                  >
                    <title>{`Idle ${formatDuration(gap.ms)} - ${gap.expired === '1h' ? '5-minute and 1-hour' : '5-minute'} cache expired, re-warm ${formatMoney(gap.rewarmCost)}`}</title>
                  </rect>
                ))}

                <g
                  role="list"
                  aria-label={plural(turns.length, 'turn')}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') { event.preventDefault(); focusBar(focused + 1); }
                    if (event.key === 'ArrowLeft') { event.preventDefault(); focusBar(focused - 1); }
                    if (event.key === 'Escape') setLabelled(null);
                  }}
                >
                  {turns.map((turn, index) => {
                    const startMs = new Date(turn.ts).getTime();
                    if (!Number.isFinite(startMs)) return null;
                    // A turn's stretch of the clock: from its prompt to the next one, and never
                    // longer than the work it recorded. Transcripts do hold turns whose recorded
                    // duration runs past the next prompt, and drawing those raw stacked four turns
                    // into one slab you could not count.
                    const nextStart = new Date(turns[index + 1]?.ts ?? bounds.end).getTime();
                    const endMs = Math.min(
                      startMs + (turn.durationMs ?? 0),
                      Number.isFinite(nextStart) ? Math.max(startMs, nextStart) : bounds.end,
                    );
                    // Three pixels and a hairline of paper: at two pixels and no stroke, adjacent
                    // turns in a short session merged into one block with no turns visible in it.
                    const barWidth = Math.max(MIN_BAR_PX, Math.min(innerWidth, x(endMs)) - x(startMs));
                    const left = Math.max(0, Math.min(x(startMs), innerWidth - barWidth));
                    const top = y(turn.cost);
                    return (
                      <rect
                        key={turn.turnIndex}
                        data-turn-index={index}
                        tabIndex={index === focused ? 0 : -1}
                        role="listitem"
                        className={styles.bar}
                        x={left}
                        y={top}
                        width={barWidth}
                        height={Math.max(1.5, barArea - top)}
                        onFocus={() => { setFocused(index); setLabelled(index); }}
                        onBlur={() => setLabelled((current) => (current === index ? null : current))}
                        onPointerEnter={() => setLabelled(index)}
                        onPointerLeave={() => setLabelled((current) => (current === index ? null : current))}
                        aria-label={`Turn ${turn.turnIndex} at ${formatDate(turn.ts, 'datetime')}: ${formatMoney(turn.cost)}, ${formatDuration(turn.durationMs ?? 0)}, ${plural(turn.requestCount, 'request')}`}
                      />
                    );
                  })}
                </g>

                {detail.requests.map((request) => {
                  const at = new Date(request.ts).getTime();
                  if (!Number.isFinite(at)) return null;
                  return <line key={request.seq} x1={x(at)} x2={x(at)} y1={barArea + 10} y2={barArea + 18} className={styles.tick} />;
                })}

                {detail.compactions.map((compaction) =>
                  compaction.ts ? (
                    <line
                      key={`c-${compaction.seq}`}
                      x1={x(new Date(compaction.ts).getTime())}
                      x2={x(new Date(compaction.ts).getTime())}
                      y1={0}
                      y2={barArea + 18}
                      className={styles.compaction}
                    />
                  ) : null,
                )}

                {detail.apiErrors.map((error) =>
                  error.ts ? (
                    <circle
                      key={`e-${error.seq}`}
                      cx={x(new Date(error.ts).getTime())}
                      cy={barArea + 12}
                      r="3"
                      className={styles.errorDot}
                    />
                  ) : null,
                )}

                <line x1="0" x2={innerWidth} y1={barArea} y2={barArea} className={styles.baseline} />
                {axisTicks.map((tick) => (
                  <text
                    key={tick.fraction}
                    x={tick.fraction * innerWidth}
                    y={innerHeight + 12}
                    textAnchor={tick.fraction === 0 ? 'start' : tick.fraction === 1 ? 'end' : 'middle'}
                    className={['num', styles.axis].join(' ')}
                  >
                    {tick.label}
                  </text>
                ))}
                {shortSpan ? (
                  <text x="0" y={innerHeight + 25} className={styles.axisNote}>
                    elapsed from {formatDate(bounds.start, 'datetime')} · one tick per request
                  </text>
                ) : (
                  <text x={innerWidth / 2} y={innerHeight + 12} textAnchor="middle" className={styles.axisNote}>
                    one tick per request
                  </text>
                )}
                {/* The label a hovered or focused turn shows. Drawn last so it sits over the bars;
                    hidden from assistive tech because each bar already carries the same sentence. */}
                {labelledTurn ? (
                  <g aria-hidden="true" transform={`translate(${labelledTurn.left},${labelledTurn.top})`}>
                    <rect className={styles.tipBox} x="0" y="0" width={labelledTurn.width} height="19" rx="2" />
                    <text className={['num', styles.tipText].join(' ')} x="7" y="13">
                      {labelledTurn.text}
                    </text>
                  </g>
                ) : null}
              </g>
            </svg>
          </div>
        </ChartFrame>
      </section>

      <section className="stack stack-sm">
        <div className="section-head">
          <h2>Idle gaps</h2>
          <span className={styles.note}>
            {gaps.length === 0 ? (
              'No gap over five minutes: the cache stayed warm from start to finish.'
            ) : (
              <>
                {plural(gaps.length, 'gap')} over five minutes, <Duration ms={totalIdle} /> idle,{' '}
                <Money usd={totalRewarm} /> spent re-warming the cache afterwards
              </>
            )}
          </span>
        </div>
        <LedgerTable
          columns={gapColumns}
          rows={gaps}
          rowKey={(gap) => gap.id}
          caption="Idle gaps and what they cost"
          dense
          maxHeight={400}
          defaultSort={{ columnId: 'cost', direction: 'desc' }}
          empty="No gap longer than five minutes: the cache stayed warm from start to finish."
        />
        <p className={styles.note}>
          Prompt caching keeps the context alive for five minutes (an hour for the 1-hour tier). After a
          longer silence the entries are gone, and the first request back pays the full cache-write price
          to put the same context in again.
        </p>
      </section>
    </div>
  );
}

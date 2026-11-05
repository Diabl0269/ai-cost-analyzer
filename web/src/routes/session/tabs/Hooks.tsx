import { useMemo } from 'react';
import type { CompactionRow, HookRunRow, InjectionCost } from '@core/types';
import { Duration } from '@/components/Duration';
import { EmptyState } from '@/components/EmptyState';
import { EstimateBadge } from '@/components/EstimateBadge';
import { LedgerTable, type LedgerColumn } from '@/components/LedgerTable';
import { Money } from '@/components/Money';
import { Tokens } from '@/components/Tokens';
import { plural, pluralNoun } from '@core/pricing/format.js';
import { EM_DASH, formatCount, formatDate } from '@/lib/format';
import { useSessionContext } from '../context';
import styles from './Hooks.module.css';

interface HookAggregate {
  key: string;
  hookName: string;
  hookEvent: string;
  runs: number;
  failures: number;
  timeouts: number;
  durationMs: number;
  injectedChars: number;
  estCost: number;
}

function aggregateHooks(runs: HookRunRow[]): HookAggregate[] {
  const byKey = new Map<string, HookAggregate>();
  for (const run of runs) {
    const hookName = run.hookName ?? run.kind;
    const hookEvent = run.hookEvent ?? EM_DASH;
    const key = `${hookName} ${hookEvent}`;
    const entry = byKey.get(key) ?? {
      key,
      hookName,
      hookEvent,
      runs: 0,
      failures: 0,
      timeouts: 0,
      durationMs: 0,
      injectedChars: 0,
      estCost: 0,
    };
    entry.runs += 1;
    if (run.kind === 'blocking_error' || (run.exitCode !== undefined && run.exitCode !== 0)) entry.failures += 1;
    if (run.timedOut) entry.timeouts += 1;
    entry.durationMs += run.durationMs ?? 0;
    entry.injectedChars += run.injectedChars;
    entry.estCost += run.estCost;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => b.estCost - a.estCost || b.durationMs - a.durationMs);
}

interface HarnessAggregate {
  name: string;
  occurrences: number;
  chars: number;
  estCost: number;
}

function aggregateHarness(injections: InjectionCost[]): HarnessAggregate[] {
  const byName = new Map<string, HarnessAggregate>();
  for (const injection of injections) {
    if (injection.kind !== 'attachment' && injection.kind !== 'system_prompt') continue;
    const entry = byName.get(injection.name) ?? { name: injection.name, occurrences: 0, chars: 0, estCost: 0 };
    entry.occurrences += 1;
    entry.chars += injection.chars;
    entry.estCost += injection.cost.ingestCost + injection.cost.carryCost;
    byName.set(injection.name, entry);
  }
  return [...byName.values()].sort((a, b) => b.estCost - a.estCost || b.chars - a.chars);
}

export default function HooksTab() {
  const { detail } = useSessionContext();
  const hooks = useMemo(() => aggregateHooks(detail.hooks), [detail.hooks]);
  const harness = useMemo(() => aggregateHarness(detail.injections), [detail.injections]);

  const hookTotals = hooks.reduce(
    (acc, row) => ({ runs: acc.runs + row.runs, ms: acc.ms + row.durationMs, cost: acc.cost + row.estCost }),
    { runs: 0, ms: 0, cost: 0 },
  );
  const harnessTotals = harness.reduce(
    (acc, row) => ({ chars: acc.chars + row.chars, cost: acc.cost + row.estCost }),
    { chars: 0, cost: 0 },
  );

  const hookColumns: LedgerColumn<HookAggregate>[] = [
    { id: 'name', header: 'Hook', width: '32%', sortValue: (row) => row.hookName, cell: (row) => <span className={styles.mono}>{row.hookName}</span> },
    { id: 'event', header: 'Event', width: '16%', secondary: true, cell: (row) => <span className={styles.muted}>{row.hookEvent}</span> },
    { id: 'runs', header: 'Runs', numeric: true, width: '70px', sortValue: (row) => row.runs, cell: (row) => formatCount(row.runs) },
    {
      id: 'failures',
      header: 'Failed',
      numeric: true,
      width: '78px',
      sortValue: (row) => row.failures,
      cell: (row) => (
        <span className={row.failures > 0 ? styles.bad : styles.muted}>
          {formatCount(row.failures)}
          {row.timeouts > 0 ? (
            <span title={`${plural(row.timeouts, 'run')} timed out`}> +{row.timeouts} {pluralNoun(row.timeouts, 'timeout')}</span>
          ) : null}
        </span>
      ),
    },
    { id: 'time', header: 'Wall time', numeric: true, width: '96px', sortValue: (row) => row.durationMs, cell: (row) => <Duration ms={row.durationMs} /> },
    {
      id: 'chars',
      header: 'Injected',
      numeric: true,
      width: '92px',
      headerTitle: 'Characters this hook added to the model context',
      sortValue: (row) => row.injectedChars,
      cell: (row) => (row.injectedChars > 0 ? <Tokens value={row.injectedChars} unit="ch" /> : <span className={styles.muted}>{EM_DASH}</span>),
    },
    {
      id: 'cost',
      header: 'Est. cost',
      numeric: true,
      width: '104px',
      sortValue: (row) => row.estCost,
      cell: (row) => (
        <span className={styles.costCell}>
          <Money usd={row.estCost} />
          <EstimateBadge method="heuristic" />
        </span>
      ),
    },
  ];

  const harnessColumns: LedgerColumn<HarnessAggregate>[] = [
    { id: 'name', header: 'Injection', width: '40%', sortValue: (row) => row.name, cell: (row) => <span className={styles.mono}>{row.name}</span> },
    { id: 'count', header: 'Occurrences', numeric: true, width: '110px', sortValue: (row) => row.occurrences, cell: (row) => formatCount(row.occurrences) },
    { id: 'chars', header: 'Characters', numeric: true, width: '110px', sortValue: (row) => row.chars, cell: (row) => <Tokens value={row.chars} unit="ch" /> },
    {
      id: 'cost',
      header: 'Est. cost',
      numeric: true,
      width: '104px',
      sortValue: (row) => row.estCost,
      cell: (row) => (
        <span className={styles.costCell}>
          <Money usd={row.estCost} />
          <EstimateBadge method="heuristic" />
        </span>
      ),
    },
  ];

  const compactionColumns: LedgerColumn<CompactionRow>[] = [
    { id: 'turn', header: 'Turn', numeric: true, width: '70px', cell: (row) => row.turnIndex },
    { id: 'trigger', header: 'Trigger', width: '120px', cell: (row) => row.trigger ?? EM_DASH },
    { id: 'pre', header: 'Before', numeric: true, cell: (row) => <Tokens value={row.preTokens ?? null} /> },
    { id: 'post', header: 'After', numeric: true, cell: (row) => <Tokens value={row.postTokens ?? null} /> },
    {
      id: 'dropped',
      header: 'Dropped',
      numeric: true,
      cell: (row) => <Tokens value={Math.max(0, (row.preTokens ?? 0) - (row.postTokens ?? 0))} />,
    },
    { id: 'took', header: 'Took', numeric: true, cell: (row) => <Duration ms={row.durationMs ?? null} /> },
    {
      id: 'rewarm',
      header: 'Re-warm',
      numeric: true,
      headerTitle: 'Cache-write cost of the first request after the boundary',
      cell: (row) => <Money usd={row.rewarmCost} />,
    },
  ];

  if (detail.summary.provider === 'codex') {
    return <EmptyState title="Attribution unavailable for Codex" description="Codex rollouts do not record Claude Code hook, skill or workflow attribution. Missing records do not mean no overhead or delegation occurred." />;
  }

  if (hooks.length === 0 && harness.length === 0 && detail.compactions.length === 0 && detail.apiErrors.length === 0) {
    return (
      <EmptyState
        icon="hook"
        title="No hooks, injections or compactions"
        description="Nothing but your prompts and the model answers filled this context."
      />
    );
  }

  return (
    <div className="stack stack-lg">
      <section className="stack stack-sm">
        <div className="section-head">
          <h2>Hooks</h2>
          <span className={styles.muted}>
            {plural(hookTotals.runs, 'run')}, <Duration ms={hookTotals.ms} /> of wall time,{' '}
            <Money usd={hookTotals.cost} /> of context
          </span>
        </div>
        <LedgerTable
          columns={hookColumns}
          rows={hooks}
          rowKey={(row) => row.key}
          caption="Hook runs"
          dense
          defaultSort={{ columnId: 'cost', direction: 'desc' }}
          empty="No hook ran in this session."
        />
      </section>

      <section className="stack stack-sm">
        <div className="section-head">
          <h2>Harness injections</h2>
          <span className={styles.muted}>
            <Tokens value={harnessTotals.chars} unit="ch" />, <Money usd={harnessTotals.cost} /> estimated
          </span>
        </div>
        <LedgerTable
          columns={harnessColumns}
          rows={harness}
          rowKey={(row) => row.name}
          caption="Harness injections by type"
          dense
          defaultSort={{ columnId: 'cost', direction: 'desc' }}
          empty="Claude Code injected nothing into this context."
        />
        <p className={styles.muted}>
          These are the blocks Claude Code adds to your context on its own: reminders, tool listings,
          skill listings, the system prompt. You pay for them once when they enter, and again on every
          later request that still carries them.
        </p>
      </section>

      {detail.compactions.length > 0 ? (
        <section className="stack stack-sm">
          <div className="section-head">
            <h2>Compactions</h2>
          </div>
          <LedgerTable
            columns={compactionColumns}
            rows={detail.compactions}
            rowKey={(row) => `${row.agentId ?? 'main'}-${row.seq}`}
            caption="Compaction boundaries"
            dense
          />
        </section>
      ) : null}

      {detail.apiErrors.length > 0 ? (
        <section className="stack stack-sm">
          <div className="section-head">
            <h2>API errors</h2>
          </div>
          <ul className={styles.errors}>
            {detail.apiErrors.map((error) => (
              <li key={error.seq}>
                <span className={styles.mono}>{error.status ?? EM_DASH}</span>
                <span className={styles.muted}>{error.ts ? formatDate(error.ts, 'datetime') : ''}</span>
                <span>{error.message ?? ''}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

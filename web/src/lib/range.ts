/**
 * Date range shared by every page, stored in the URL (`from` / `to`) so links and
 * reloads keep the same window. Presets are derived, not stored.
 *
 * The two imports below are relative-with-`.js` rather than `@core/…` / extensionless, for the
 * same reason `lib/format.ts` is: this module is type-checked by both `tsconfig.web.json`
 * (Bundler resolution, `@core` alias) and `tsconfig.tests.json` (NodeNext, no alias), and only an
 * explicit relative specifier satisfies both.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { readProvider, type Provider } from './provider.js';
import type { RangeQuery } from '../../../core/types.js';
import { fromIsoDay, formatDate, toIsoDay } from './format.js';

export type RangePresetId = 'today' | '7d' | '30d' | 'month' | 'lastMonth' | 'all' | 'custom';

export interface DateRangeValue {
  preset: RangePresetId;
  /** inclusive local `YYYY-MM-DD`; undefined = unbounded */
  from?: string;
  to?: string;
}

export interface RangePreset {
  id: Exclude<RangePresetId, 'custom'>;
  label: string;
}

export const RANGE_PRESETS: RangePreset[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'month', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'all', label: 'All' },
];

function daysAgo(now: Date, days: number): Date {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  date.setDate(date.getDate() - days);
  return date;
}

/**
 * The floor `all` uses. Claude Code did not exist before this, so an explicit lower bound is
 * honest and — unlike an absent one — survives the server's 30-day default (`DEFAULT_RANGE_DAYS`
 * in `core/db/filters.ts`), which is what a missing `from` actually resolves to.
 */
export const ALL_TIME_FROM = '2000-01-01';

/**
 * Resolves a preset to concrete inclusive local days. `all` is explicit rather than unbounded:
 * an unbounded query is *not* all time on the wire — the server fills a missing bound with the
 * last 30 days — so `all` has to say so.
 */
export function presetRange(id: RangePresetId, now: Date = new Date()): { from?: string; to?: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (id) {
    case 'today':
      return { from: toIsoDay(today), to: toIsoDay(today) };
    case '7d':
      return { from: toIsoDay(daysAgo(now, 6)), to: toIsoDay(today) };
    case '30d':
      return { from: toIsoDay(daysAgo(now, 29)), to: toIsoDay(today) };
    case 'month':
      return { from: toIsoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: toIsoDay(today) };
    case 'lastMonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: toIsoDay(first), to: toIsoDay(last) };
    }
    case 'all':
      return { from: ALL_TIME_FROM, to: toIsoDay(today) };
    case 'custom':
      return {};
  }
}

/**
 * Which preset (if any) produced this window. An empty window is **not** "all": the server
 * resolves missing bounds to the last 30 days, so that is what the top bar must highlight.
 */
export function matchPreset(from: string | undefined, to: string | undefined, now: Date = new Date()): RangePresetId {
  if (!from && !to) return '30d';
  for (const preset of RANGE_PRESETS) {
    const candidate = presetRange(preset.id, now);
    if (candidate.from === from && candidate.to === to) return preset.id;
  }
  return 'custom';
}

export function rangeLabel(value: DateRangeValue): string {
  if (value.preset !== 'custom') {
    return RANGE_PRESETS.find((preset) => preset.id === value.preset)?.label ?? 'All';
  }
  const from = value.from ? formatDate(fromIsoDay(value.from), 'day') : 'start';
  const to = value.to ? formatDate(fromIsoDay(value.to), 'day') : 'now';
  return `${from} – ${to}`;
}

const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** The window the server falls back to when a bound is missing (`DEFAULT_RANGE_DAYS`). */
const DEFAULT_WINDOW_SENTENCE = 'the last 30 days';

/**
 * The one way this app names a window in prose: `Aug 11 – Sep 9, 2026`, `Sep 9, 2026` for a
 * single day, `All time through Sep 9, 2026` for the unbounded preset. Every page that prints
 * the selected range calls this — the overview and the insights page used to print the same
 * window in two formats ("Aug 11, 2026 – Sep 9, 2026" against "2026-08-11 → 2026-09-09").
 */
export function formatRangeSentence(from: string | undefined, to: string | undefined): string {
  const start = from ? fromIsoDay(from) : null;
  const end = to ? fromIsoDay(to) : null;
  if (!start || !end) return DEFAULT_WINDOW_SENTENCE;
  if (from === to) return MONTH_DAY_YEAR.format(end);
  if (from && from <= ALL_TIME_FROM) return `All time through ${MONTH_DAY_YEAR.format(end)}`;
  const sameYear = start.getFullYear() === end.getFullYear();
  return `${sameYear ? MONTH_DAY.format(start) : MONTH_DAY_YEAR.format(start)} – ${MONTH_DAY_YEAR.format(end)}`;
}

const DAY_MS = 86_400_000;

/** Inclusive count of local days in `[from, to]`, or 0 when either bound is unparseable. */
export function dayCount(from: string, to: string): number {
  const start = fromIsoDay(from);
  const end = fromIsoDay(to);
  if (!start || !end || end.getTime() < start.getTime()) return 0;
  // Rounding absorbs the ±1h a DST boundary puts into the millisecond difference.
  return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

/** Every inclusive local day from `from` to `to`, as `YYYY-MM-DD`. */
export function eachDay(from: string, to: string): string[] {
  const start = fromIsoDay(from);
  const days = dayCount(from, to);
  if (!start || days === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    out.push(toIsoDay(day));
  }
  return out;
}

/**
 * More cells than this and a daily strip stops being readable at any width, so the fill falls
 * back to the extent of the data instead of the requested window (the `all` preset asks for
 * 2000-01-01 → today, which is ~9,700 cells).
 */
export const MAX_DENSE_DAYS = 400;

/**
 * Turns a sparse daily series — the API returns one entry per **non-empty** day — into one entry
 * per day across the window, so the x axis is time rather than "days that happened to bill".
 * Without this a strip of `flex: 1` cells silently drops every zero day and the reader sees a
 * dense month where there were five working days.
 */
export function fillDailySeries<T extends { date: string }>(
  rows: readonly T[],
  from: string | undefined,
  to: string | undefined,
  empty: (date: string) => T,
  maxDays: number = MAX_DENSE_DAYS,
): T[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let start = from;
  let end = to;
  if (!start || !end || dayCount(start, end) > maxDays) {
    start = sorted[0]?.date;
    end = sorted[sorted.length - 1]?.date;
  }
  if (!start || !end) return sorted;
  const span = dayCount(start, end);
  if (span === 0 || span > maxDays) return sorted;
  const byDate = new Map(sorted.map((row) => [row.date, row]));
  return eachDay(start, end).map((date) => byDate.get(date) ?? empty(date));
}

export interface DateRangeStore {
  value: DateRangeValue;
  /** Applies a preset. Every preset except `custom` writes explicit `from`/`to`. */
  setPreset: (id: RangePresetId) => void;
  setBounds: (bounds: { from?: string; to?: string }) => void;
  /** RangeQuery for the API, including the current project filter. */
  query: RangeQuery;
  project?: string;
  provider?: Provider;
  setProvider: (provider: Provider | undefined) => void;
  setProject: (projectId: string | undefined) => void;
}

/** Reads and writes `from`, `to` and `project` on the current URL. */
export function useDateRange(): DateRangeStore {
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  const project = params.get('project') ?? undefined;
  const provider = readProvider(params.toString());

  const write = useCallback(
    (next: { from?: string; to?: string; project?: string }) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          for (const key of ['from', 'to', 'project'] as const) {
            const value = next[key];
            if (value) updated.set(key, value);
            else updated.delete(key);
          }
          return updated;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );

  const setPreset = useCallback(
    (id: RangePresetId) => {
      const bounds = presetRange(id);
      write({ ...bounds, project });
    },
    [write, project],
  );

  const setBounds = useCallback(
    (bounds: { from?: string; to?: string }) => write({ ...bounds, project }),
    [write, project],
  );

  const setProject = useCallback(
    (next: string | undefined) => write({ from, to, project: next }),
    [write, from, to],
  );

  const setProvider = useCallback((next: Provider | undefined) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next) updated.set('provider', next);
      else updated.delete('provider');
      // Pagination cursors are only valid for their original provider.
      updated.delete('cursor');
      return updated;
    }, { replace: true, preventScrollReset: true });
  }, [setParams]);

  return useMemo<DateRangeStore>(() => {
    const value: DateRangeValue = { preset: matchPreset(from, to), from, to };
    const query: RangeQuery = { from, to, project, provider };
    return { value, setPreset, setBounds, query, project, setProject, provider, setProvider };
  }, [from, to, project, provider, setPreset, setBounds, setProject, setProvider]);
}

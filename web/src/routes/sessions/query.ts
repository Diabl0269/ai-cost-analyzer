/**
 * URL state for the session ledger.
 *
 * Every knob the toolbar owns lives in the query string, so a filtered list is a shareable
 * link, the CSV export can reuse the same object verbatim, and a reload keeps the view.
 * `from` / `to` / `project` stay with `useDateRange` — this hook only adds the list filters.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { SessionSort, SessionsQuery } from '@core/types';
import { useDateRange, sessionBounds } from '@/lib/range';

export const SESSION_SORTS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Last activity' },
  { value: 'cost', label: 'Cost' },
  { value: 'started', label: 'Started' },
  { value: 'duration', label: 'Duration' },
  { value: 'prompts', label: 'Prompts' },
  { value: 'requests', label: 'Requests' },
  { value: 'tools', label: 'Tool calls' },
];

/** SPEC §3.2: the entrypoints Claude Code writes. */
export const ENTRYPOINTS: { value: string; label: string }[] = [
  { value: 'cli', label: 'CLI' },
  { value: 'claude-desktop', label: 'Desktop' },
  { value: 'sdk-cli', label: 'SDK' },
];

export const PAGE_SIZE = 50;

export interface SessionFilters {
  q: string;
  sort: SessionSort;
  order: 'asc' | 'desc';
  pinned: boolean;
  hasAgents: boolean;
  entrypoint: string;
  model: string;
}

const DEFAULTS: SessionFilters = {
  q: '',
  sort: 'recent',
  order: 'desc',
  pinned: false,
  hasAgents: false,
  entrypoint: '',
  model: '',
};

const FILTER_KEYS = ['q', 'sort', 'order', 'pinned', 'hasAgents', 'entrypoint', 'model'] as const;

const isSort = (value: string): value is SessionSort =>
  SESSION_SORTS.some((option) => option.value === value);

export interface SessionListState {
  filters: SessionFilters;
  /** the one query object the table, the totals footer and the CSV link all use */
  query: SessionsQuery;
  set: (patch: Partial<SessionFilters>) => void;
  clear: () => void;
  /** how many filters are narrowing the list (drives the "clear" affordance) */
  activeCount: number;
}

export function useSessionList(): SessionListState {
  const [params, setParams] = useSearchParams();
  const range = useDateRange();

  const rawSort = params.get('sort') ?? '';
  const filters = useMemo<SessionFilters>(
    () => ({
      q: params.get('q') ?? DEFAULTS.q,
      sort: isSort(rawSort) ? rawSort : DEFAULTS.sort,
      order: params.get('order') === 'asc' ? 'asc' : 'desc',
      pinned: params.get('pinned') === 'true',
      hasAgents: params.get('hasAgents') === 'true',
      entrypoint: params.get('entrypoint') ?? DEFAULTS.entrypoint,
      model: params.get('model') ?? DEFAULTS.model,
    }),
    [params, rawSort],
  );

  const set = useCallback(
    (patch: Partial<SessionFilters>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const key of FILTER_KEYS) {
            if (!(key in patch)) continue;
            const value = patch[key];
            if (value === undefined || value === DEFAULTS[key] || value === false || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );

  const clear = useCallback(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of FILTER_KEYS) next.delete(key);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [setParams]);

  const { from, to, project, provider } = range.query;
  const query = useMemo<SessionsQuery>(() => {
    const built: SessionsQuery = { ...sessionBounds(from, to), sort: filters.sort, order: filters.order, limit: PAGE_SIZE };
    if (from) built.from = from;
    if (to) built.to = to;
    if (project) built.project = project;
    if (provider) built.provider = provider;
    if (filters.q) built.q = filters.q;
    if (filters.model) built.model = filters.model;
    if (filters.entrypoint && provider !== 'codex' && provider !== 'copilot') built.entrypoint = filters.entrypoint;
    if (filters.pinned) built.pinned = true;
    if (filters.hasAgents) built.hasAgents = true;
    return built;
  }, [from, to, project, provider, filters]);

  const activeCount = FILTER_KEYS.filter(
    (key) => key !== 'sort' && key !== 'order' && filters[key] !== DEFAULTS[key],
  ).length;

  return { filters, query, set, clear, activeCount };
}

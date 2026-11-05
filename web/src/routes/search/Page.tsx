import { hasNoRecordedUsage } from '@/lib/usage';
import { providerLabel } from '@/lib/provider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Link } from '@/lib/navigation';
import { plural } from '@core/pricing/format.js';
import type { MessageKind, SearchKind, SearchQuery, SearchScope } from '@core/types';
import { Button } from '@/components/Button';
import { Callout } from '@/components/Callout';
import { EmptyState } from '@/components/EmptyState';
import { Icon } from '@/components/Icon';
import { Money } from '@/components/Money';
import { RelativeTime } from '@/components/RelativeTime';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Select } from '@/components/Select';
import { Skeleton } from '@/components/Skeleton';
import { useModelsAnalytics, useSearch } from '@/lib/queries';
import { useDateRange } from '@/lib/range';
import { useShortcuts } from '@/lib/keyboard';
import { formatCount, formatModelLabel } from '@/lib/format';
import { shortProjectPath } from '@/routes/sessions/meta';
import { renderSnippet } from './snippet';
import styles from './Page.module.css';

const KINDS: { value: SearchKind; label: string }[] = [
  { value: 'prompt', label: 'Prompts' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'tool_use', label: 'Tool calls' },
  { value: 'tool_result', label: 'Tool results' },
];

const KIND_LABEL: Partial<Record<MessageKind, string>> = {
  prompt: 'prompt',
  assistant: 'assistant',
  tool_result: 'tool result',
  compact_summary: 'compaction summary',
  meta: 'harness line',
  system: 'system line',
  attachment: 'harness line',
  interrupt: 'interrupt',
};

const isKind = (value: string): value is SearchKind => KINDS.some((kind) => kind.value === value);

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const range = useDateRange();
  const models = useModelsAnalytics(range.query);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const q = params.get('q') ?? '';
  const scope: SearchScope = params.get('scope') === 'titles' ? 'titles' : 'everything';
  const kinds = useMemo(() => (params.get('kinds') ?? '').split(',').filter(isKind), [params]);
  const model = params.get('model') ?? '';
  const tool = params.get('tool') ?? '';
  const [text, setText] = useState(q);
  const [toolText, setToolText] = useState(tool);
  const [cursors, setCursors] = useState<string[]>([]);

  useEffect(() => setText(q), [q]);
  useEffect(() => setToolText(tool), [tool]);

  const write = useCallback(
    (patch: Record<string, string | undefined>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
      setCursors([]);
    },
    [setParams],
  );

  useEffect(() => {
    if (toolText === tool) return;
    const timer = setTimeout(() => write({ tool: toolText }), 300);
    return () => clearTimeout(timer);
  }, [toolText, tool, write]);

  // The results are live, so the query field writes itself into the URL after a pause instead of
  // waiting for a submit button. Enter still works — it just writes the same value sooner.
  useEffect(() => {
    if (text.trim() === q) return;
    const timer = setTimeout(() => write({ q: text.trim() }), 250);
    return () => clearTimeout(timer);
  }, [text, q, write]);

  const query = useMemo<SearchQuery>(() => {
    const built: SearchQuery = { ...range.query, q, scope, limit: 20 };
    if (range.query.from) built.from = range.query.from;
    if (range.query.to) built.to = range.query.to;
    if (range.query.project) built.project = range.query.project;
    if (kinds.length > 0) built.kinds = kinds;
    if (model) built.model = model;
    if (tool) built.tool = tool;
    const cursor = cursors[cursors.length - 1];
    if (cursor) built.cursor = cursor;
    return built;
  }, [q, scope, range.query, kinds, model, tool, cursors]);

  useEffect(() => setCursors([]), [range.provider]);

  const search = useSearch(query);

  const groups = search.data?.groups ?? [];

  const focusHit = useCallback((delta: number) => {
    const hits = [...(resultsRef.current?.querySelectorAll<HTMLElement>('[data-hit]') ?? [])];
    if (hits.length === 0) return;
    const active = document.activeElement;
    const index = hits.findIndex((hit) => hit === active || hit.contains(active));
    const next = index < 0 ? 0 : Math.max(0, Math.min(index + delta, hits.length - 1));
    hits[next]?.focus();
  }, []);

  useShortcuts([
    { id: 'search-next-hit', keys: 'j', description: 'Next result', group: 'Rows', run: () => focusHit(1) },
    { id: 'search-prev-hit', keys: 'k', description: 'Previous result', group: 'Rows', run: () => focusHit(-1) },
  ]);

  const toggleKind = (kind: SearchKind): void => {
    const next = kinds.includes(kind) ? kinds.filter((value) => value !== kind) : [...kinds, kind];
    write({ kinds: next.join(',') });
  };

  const activeFilters = kinds.length + (model ? 1 : 0) + (tool ? 1 : 0) + (range.query.project ? 1 : 0);

  return (
    <div className="stack">
      <header className={styles.head}>
        <div>
          <p className="eyebrow">Find</p>
          <h1>Search</h1>
        </div>
        {search.data ? (
          <p className={styles.meta}>
            {plural(search.data.totalSessions, 'session')} matched in{' '}
            <span className="num">{search.data.tookMs}</span> ms
          </p>
        ) : null}
      </header>

      <form
        className={styles.form}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          write({ q: text.trim() });
        }}
      >
        <div className={styles.field}>
          <Icon name="search" size={16} className={styles.fieldIcon} />
          <input
            ref={inputRef}
            type="search"
            className={styles.input}
            value={text}
            autoFocus
            placeholder={scope === 'titles' ? 'Search session titles' : 'Search every prompt, answer and tool call'}
            aria-label="Search query"
            data-page-search=""
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <SegmentedControl
          label="Search scope"
          value={scope}
          onChange={(value) => write({ scope: value === 'titles' ? 'titles' : undefined })}
          options={[
            { value: 'everything', label: 'Everything' },
            { value: 'titles', label: 'Titles' },
          ]}
        />
      </form>

      {/* One bar, four groups, hairline dividers: the kinds, the model, the tool and the project
          are all the same kind of narrowing, and used to read as four loose controls. */}
      <div className={styles.filters} role="group" aria-label="Narrow the results">
        <span className={styles.filterGroup}>
          <span className="eyebrow">Kinds</span>
          <span className={styles.chips}>
            {KINDS.map((kind) => (
              <button
                key={kind.value}
                type="button"
                className={styles.chip}
                aria-pressed={kinds.includes(kind.value)}
                disabled={scope === 'titles'}
                onClick={() => toggleKind(kind.value)}
              >
                {kind.label}
              </button>
            ))}
          </span>
        </span>
        <span className={styles.divider} aria-hidden="true" />
        <span className={styles.filterGroup}>
          <Select
            label="Model"
            hideLabel
            value={model}
            onChange={(value) => write({ model: value })}
            options={[
              { value: '', label: 'Any model' },
              ...(models.data?.models ?? []).map((row) => ({ value: row.model, label: row.label || formatModelLabel(row.model) })),
            ]}
          />
          <label className={styles.toolField}>
            <span className="visually-hidden">Tool name</span>
            <input
              type="search"
              value={toolText}
              placeholder="Tool name"
              className={styles.toolInput}
              onChange={(event) => setToolText(event.target.value)}
            />
          </label>
        </span>
        <span className={styles.divider} aria-hidden="true" />
        <span className={styles.filterGroup}>
          {range.query.project ? (
            <button type="button" className={styles.projectChip} onClick={() => range.setProject(undefined)}>
              <Icon name="close" size={11} /> {shortProjectPath(range.query.project)}
            </button>
          ) : (
            <span className={styles.hint}>pick a project in the rail to narrow the search</span>
          )}
        </span>
        {activeFilters > 0 ? (
          <span className={styles.clear}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                write({ kinds: undefined, model: undefined, tool: undefined });
                range.setProject(undefined);
              }}
            >
              Clear filters
            </Button>
          </span>
        ) : null}
      </div>

      {q.trim().length === 0 ? (
        <EmptyState
          icon="search"
          title="Search your whole history"
          description="Every prompt, answer, thinking block, tool call and tool result recorded by Claude Code or Codex, priced at API list rates. Titles are matched as substrings; everything else is full-text."
        />
      ) : search.isPending ? (
        <div className="stack">
          <Skeleton lines={4} height={14} />
        </div>
      ) : search.isError ? (
        <Callout tone="warn" title="The search could not run">
          The index may still be building, or the query was rejected. Try a simpler query.
        </Callout>
      ) : groups.length === 0 ? (
        <EmptyState
          icon="search"
          title={`Nothing matched “${q}”`}
          description="Try the other scope, widen the date range, or drop a filter."
        />
      ) : (
        <div className="stack" ref={resultsRef}>
          {groups.map((group) => (
            <article key={group.session.id} className={styles.group}>
              <header className={styles.groupHead}>
                <Link className={styles.groupTitle} to={`/sessions/${encodeURIComponent(group.session.id)}`}>
                  {group.session.title}
                </Link>
                {group.titleMatch ? <span className={styles.titleMatch}>title match</span> : null}
                <span className={styles.groupMeta} title={group.session.projectPath}>
                  {providerLabel(group.session.provider)} · {shortProjectPath(group.session.projectPath)}
                </span>
                <RelativeTime value={group.session.startedAt} live={false} className={styles.groupMeta} />
                {hasNoRecordedUsage(group.session) ? <span className={styles.groupCost}>Cost unavailable</span> : <Money usd={group.session.cost.total} className={styles.groupCost} />}
              </header>
              {group.hits.length === 0 ? (
                <p className={styles.noHits}>Matched on the title.</p>
              ) : (
                <ul className={styles.hits}>
                  {group.hits.map((hit) => (
                    <li key={`${hit.agentId ?? 'main'}-${hit.seq}`}>
                      <Link
                        data-hit
                        className={styles.hit}
                        to={
                          hit.agentId
                            ? `/sessions/${encodeURIComponent(group.session.id)}/agents/${encodeURIComponent(hit.agentId)}?seq=${hit.seq}`
                            : `/sessions/${encodeURIComponent(group.session.id)}/transcript?seq=${hit.seq}`
                        }
                      >
                        <span className={styles.hitKind}>
                          {KIND_LABEL[hit.kind] ?? hit.kind}
                          {hit.agentId ? ' · agent' : ''}
                        </span>
                        <span className={styles.snippet}>{renderSnippet(hit.snippet, styles.mark ?? '')}</span>
                        <span className={styles.hitSeq}>#{hit.seq}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {group.hitCount >= 3 ? (
                <Link className={styles.more} to={`/sessions/${encodeURIComponent(group.session.id)}/transcript`}>
                  more matches in this session
                  <Icon name="chevron" size={11} />
                </Link>
              ) : null}
            </article>
          ))}

          {search.data?.nextCursor ? (
            <div className={styles.loadMore}>
              <Button
                variant="secondary"
                onClick={() => setCursors((previous) => [...previous, search.data.nextCursor as string])}
              >
                Load more sessions
              </Button>
            </div>
          ) : null}
          {cursors.length > 0 ? (
            <p className={styles.pageNote}>
              Page {cursors.length + 1}.{' '}
              <button type="button" className={styles.linkButton} onClick={() => setCursors([])}>
                back to the first page
              </button>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { ModelCostRow } from '@core/types';
import { Icon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { Select } from '@/components/Select';
import { Switch } from '@/components/Switch';
import { Button } from '@/components/Button';
import { formatModelLabel } from '@/lib/format';
import { ENTRYPOINTS, SESSION_SORTS, type SessionListState } from './query';
import styles from './Toolbar.module.css';

export interface ToolbarProps {
  list: SessionListState;
  models: ModelCostRow[];
  csvHref: string;
}

/** Everything that narrows the ledger, in one hairline strip above it. */
export function Toolbar({ list, models, csvHref }: ToolbarProps) {
  const { filters, set } = list;
  const [text, setText] = useState(filters.q);

  // The URL is the source of truth, but a query per keystroke would refetch the list on every
  // letter: keep the field local and write the URL once the typing settles.
  useEffect(() => setText(filters.q), [filters.q]);
  useEffect(() => {
    if (text === filters.q) return;
    const timer = setTimeout(() => set({ q: text }), 250);
    return () => clearTimeout(timer);
  }, [text, filters.q, set]);

  return (
    <div className={styles.toolbar}>
      <div className={styles.field}>
        <Icon name="search" size={14} className={styles.fieldIcon} />
        <input
          type="search"
          className={styles.input}
          value={text}
          placeholder="Filter by title or first prompt"
          aria-label="Filter sessions by title or first prompt"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              set({ q: text });
            }
          }}
        />
      </div>

      <div className={styles.group}>
        <Select
          label="Sort by"
          hideLabel
          value={filters.sort}
          onChange={(value) => set({ sort: SESSION_SORTS.find((s) => s.value === value)?.value ?? 'recent' })}
          options={SESSION_SORTS.map((option) => ({ value: option.value, label: `Sort: ${option.label}` }))}
        />
        <IconButton
          icon="chevron"
          rotate={filters.order === 'asc' ? -90 : 90}
          variant="outline"
          label={filters.order === 'asc' ? 'Ascending — switch to descending' : 'Descending — switch to ascending'}
          onClick={() => set({ order: filters.order === 'asc' ? 'desc' : 'asc' })}
        />
      </div>

      {list.query.provider !== 'codex' ? <Select
        label="Entrypoint"
        hideLabel
        value={filters.entrypoint}
        onChange={(value) => set({ entrypoint: value })}
        options={[{ value: '', label: 'Any Claude entrypoint' }, ...ENTRYPOINTS.map((e) => ({ value: e.value, label: e.label }))]}
      /> : null}

      <Select
        label="Model"
        hideLabel
        value={filters.model}
        onChange={(value) => set({ model: value })}
        options={[
          { value: '', label: 'Any model' },
          ...models.map((row) => ({ value: row.model, label: row.label || formatModelLabel(row.model) })),
        ]}
      />

      <div className={styles.switches}>
        <Switch checked={filters.pinned} onChange={(checked) => set({ pinned: checked })} label="Pinned" leading />
        <Switch checked={filters.hasAgents} onChange={(checked) => set({ hasAgents: checked })} label="Has agents" leading />
      </div>

      <div className={styles.end}>
        {list.activeCount > 0 ? (
          <Button variant="ghost" size="sm" iconStart="close" onClick={list.clear}>
            Clear {list.activeCount}
          </Button>
        ) : null}
        <a className={styles.csv} href={csvHref} download>
          <Icon name="download" size={14} />
          Export CSV
        </a>
      </div>
    </div>
  );
}

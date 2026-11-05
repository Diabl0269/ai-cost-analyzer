import { providerLabel } from '@/lib/provider';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { plural } from '@core/pricing/format.js';
import type { SessionSummary } from '@core/types';
import { Button, Money } from '@/components';
import type { CurrencyDisplay } from '@/lib/format';
import { formatDate, truncate } from '@/lib/format';
import { useSessions } from '@/lib/queries';
import { useDateRange } from '@/lib/range';
import styles from './SessionPicker.module.css';

export interface SessionPickerProps {
  label: string;
  /** the chosen session, when it has loaded */
  selected: SessionSummary | null;
  selectedId: string | null;
  onSelect: (sessionId: string | null) => void;
  currency: CurrencyDisplay;
}

/**
 * Typeahead over `GET /api/sessions?q=`. A real combobox: the input owns the focus, the list is
 * addressed with `aria-activedescendant`, and Escape closes without changing the selection.
 */
export function SessionPicker({ label, selected, selectedId, onSelect, currency }: SessionPickerProps) {
  const range = useDateRange();
  const id = useId().replace(/:/g, '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const search = useSessions({ provider: range.provider, project: range.project, q: query.trim() || undefined, limit: 8, sort: 'recent' }, open);
  const options = useMemo(() => search.data?.sessions ?? [], [search.data]);

  useEffect(() => setActive(0), [options]);

  const resultsMessage = search.isPending
    ? 'Searching sessions'
    : options.length === 0
      ? 'No session matches'
      : `${plural(options.length, 'session')}. Use the arrow keys to review, Enter to choose.`;

  const choose = (session: SessionSummary): void => {
    onSelect(session.id);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => Math.max(0, Math.min(current + step, options.length - 1)));
      return;
    }
    if (event.key === 'Enter') {
      const session = options[active];
      if (open && session) {
        event.preventDefault();
        choose(session);
      }
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  if (selectedId && selected) {
    return (
      <div className={styles.chosen}>
        <span className={styles.label}>{label}</span>
        <div className={styles.chosenHead}>
          <span className={styles.chosenTitle}>{providerLabel(selected.provider)} · {selected.title}</span>
          <Money usd={selected.cost.total} currency={currency} />
        </div>
        <span className={styles.chosenMeta}>
          {selected.projectPath} · {formatDate(selected.startedAt, 'datetime')}
        </span>
        <div className="cluster" style={{ marginTop: 'var(--s2)' }}>
          <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
            Choose a different session
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.picker}>
      <label className={styles.label} htmlFor={`${id}-input`}>
        {label}
      </label>
      <input
        id={`${id}-input`}
        ref={inputRef}
        className={styles.input}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${id}-option-${active}` : undefined}
        placeholder={selectedId ? 'Loading…' : 'Search sessions by title'}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {/* The result count, announced politely. Without it the list appears silently and a
          screen-reader user has no way to know whether typing another letter helped. */}
      <span className="visually-hidden" role="status">
        {open ? resultsMessage : ''}
      </span>
      {open ? (
        <div className={styles.panel}>
          {search.isPending || options.length === 0 ? (
            <p className={styles.status}>{search.isPending ? 'Searching…' : 'No session matches.'}</p>
          ) : null}
          <ul className={styles.listbox} id={`${id}-list`} role="listbox" aria-label={label}>
          {options.map((session, index) => (
            <li
              key={session.id}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === active}
              className={styles.option}
              onPointerDown={(event) => {
                event.preventDefault();
                choose(session);
              }}
              onPointerEnter={() => setActive(index)}
            >
              <span className="truncate">{truncate(session.title, 52)}</span>
              <span className={styles.optionMeta}>
                {providerLabel(session.provider)} · {formatDate(session.startedAt, 'day')} · <Money usd={session.cost.total} currency={currency} />
              </span>
            </li>
          ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

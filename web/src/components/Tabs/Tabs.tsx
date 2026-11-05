import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { NavLink } from '@/lib/navigation';
import styles from './Tabs.module.css';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** when set the tab is a link and the router owns the state */
  to?: string;
  /** small trailing count */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  /** the active tab id (link mode: derive it from the route params) */
  value: string;
  onChange?: (id: string) => void;
  label: string;
  size?: 'sm' | 'md';
  /** panel id controlled by the active tab (button mode) */
  panelId?: string;
}

/**
 * WAI-ARIA tabs with automatic activation. Two modes:
 * buttons (`value` + `onChange`) or links (`to` on each item, state from the URL).
 */
export function Tabs({ items, value, onChange, label, size = 'md', panelId }: TabsProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const linkMode = items.some((item) => item.to !== undefined);
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === value));

  const focusTab = (index: number): void => {
    listRef.current?.querySelector<HTMLElement>(`[data-tab-index="${index}"]`)?.focus();
  };

  const move = (delta: number): void => {
    if (items.length === 0) return;
    let next = activeIndex;
    for (let step = 0; step < items.length; step += 1) {
      next = (next + delta + items.length) % items.length;
      const candidate = items[next];
      if (candidate && !candidate.disabled) {
        if (!linkMode) onChange?.(candidate.id);
        focusTab(next);
        return;
      }
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      const first = items[0];
      if (first) {
        if (!linkMode) onChange?.(first.id);
        focusTab(0);
      }
    } else if (event.key === 'End') {
      event.preventDefault();
      const lastIndex = items.length - 1;
      const last = items[lastIndex];
      if (last) {
        if (!linkMode) onChange?.(last.id);
        focusTab(lastIndex);
      }
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={[styles.list, styles[size]].join(' ')}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) =>
        item.to !== undefined ? (
          <NavLink
            key={item.id}
            to={item.to}
            end
            data-tab-index={index}
            className={[styles.tab, item.id === value ? styles.active : null].filter(Boolean).join(' ')}
            role="tab"
            aria-selected={item.id === value}
            tabIndex={item.id === value ? 0 : -1}
          >
            <span>{item.label}</span>
            {item.count === undefined ? null : <span className={['num', styles.count].join(' ')}>{item.count}</span>}
          </NavLink>
        ) : (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${item.id}-tab`}
            data-tab-index={index}
            aria-selected={item.id === value}
            aria-controls={panelId}
            tabIndex={item.id === value ? 0 : -1}
            disabled={item.disabled}
            className={[styles.tab, item.id === value ? styles.active : null].filter(Boolean).join(' ')}
            onClick={() => onChange?.(item.id)}
          >
            <span>{item.label}</span>
            {item.count === undefined ? null : <span className={['num', styles.count].join(' ')}>{item.count}</span>}
          </button>
        ),
      )}
    </div>
  );
}

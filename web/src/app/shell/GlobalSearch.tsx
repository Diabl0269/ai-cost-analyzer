import { useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useNavigate } from '@/lib/navigation';
import { Icon } from '@/components/Icon';
import { useShortcuts } from '@/lib/keyboard';
import styles from './GlobalSearch.module.css';

/** The search page marks its own field with this, so `/` can hand focus to it. */
const PAGE_SEARCH_SELECTOR = '[data-page-search]';

export interface GlobalSearchProps {
  /**
   * Renders no field, but keeps the `/` shortcut registered. Set on `/search`, whose own field
   * carries scope, filters and a tool name — two search boxes on one screen is one too many.
   */
  hideField?: boolean;
}

/** Top-bar search. `/` focuses it; Enter navigates to the search page. */
export function GlobalSearch({ hideField = false }: GlobalSearchProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(params.get('q') ?? '');

  useShortcuts([
    {
      id: 'focus-search',
      keys: '/',
      description: 'Focus search',
      group: 'Search',
      run: () => {
        // On /search the page owns the query field. One global `/` would otherwise swallow the
        // keystroke and focus the top bar, leaving the field the user is looking at untouched.
        const onSearchPage = location.pathname === '/search';
        const target = onSearchPage
          ? (document.querySelector<HTMLInputElement>(PAGE_SEARCH_SELECTOR) ?? inputRef.current)
          : inputRef.current;
        // Under 720px the bar hides its field. Focusing something that is not laid out does
        // nothing, so the keystroke opens the search page instead of being swallowed.
        if (!target || target.offsetParent === null) {
          navigate('/search');
          return;
        }
        target.focus();
        target.select();
      },
    },
  ]);

  if (hideField) return null;

  return (
    <form
      className={styles.form}
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (query) navigate(`/search?q=${encodeURIComponent(query)}`);
      }}
    >
      <Icon name="search" size={14} className={styles.icon} />
      <input
        ref={inputRef}
        type="search"
        className={styles.input}
        placeholder="Search sessions and transcripts"
        aria-label="Search sessions and transcripts"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <kbd className={styles.kbd} aria-hidden="true">
        /
      </kbd>
    </form>
  );
}
